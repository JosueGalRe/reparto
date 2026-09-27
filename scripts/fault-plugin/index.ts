// Dev-only fault injector for the 1.8 scenarios (loaded by scripts/config, never by the real config).
// Reads /tmp/reparto-dev/faults.json: [{ "providerID": "claude-code", "agent"?: "visual", "kind": "claude-limit", "remaining": 1 }]
// And replaces a `primary` response (http.response) or WebSocket frame (openai) with the error bodies seen in the S3 probes.
// It must be listed before reparto in `plugins` so reparto's hooks see the replaced response.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

import { Plugin } from '@opencode/plugin'

const file = '/tmp/reparto-dev/faults.json'

type Kind = 'quota' | 'claude-limit' | 'rate' | '503' | '401' | 'openai-quota'
interface Fault {
  providerID: string
  agent?: string
  kind: Kind
  remaining: number
}

function take(providerID: string, agent: string): Kind | undefined {
  let faults: Fault[]

  try {
    faults = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return
  }

  const fault = faults.find(
    (entrada) => entrada.providerID === providerID && (!entrada.agent || entrada.agent === agent) && entrada.remaining > 0,
  )

  if (!fault) {
    return
  }

  fault.remaining--
  writeFileSync(file, JSON.stringify(faults, null, 2))
  appendFileSync('/tmp/reparto-dev/faults.log', `${new Date().toISOString()} ${providerID} ${agent} ${fault.kind}\n`)

  return fault.kind
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'content-type': 'application/json;charset=utf-8', ...headers } })

function response(kind: Kind): Response {
  const resetsAt = new Date(Date.now() + 3 * 60_000).toISOString()

  switch (kind) {
    case 'quota': {
      return json(429, {
        error: {
          message: 'You exceeded your current quota, please check your plan and billing details.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
      })
    }

    case 'claude-limit': {
      return json(
        429,
        {
          error: {
            message: "You've hit your limit · limit resets in 3m",
            type: 'rate_limit_error',
            code: 'claude_session_limit',
            resets_at: resetsAt,
            retry_after: 180,
          },
        },
        { 'retry-after': '180', 'x-claude-rate-limit-reset': resetsAt },
      )
    }

    case 'rate': {
      return json(
        429,
        { error: { message: 'Rate limit reached for requests', type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' } },
        { 'retry-after': '2' },
      )
    }

    case '503': {
      return json(503, { error: { message: 'Service Unavailable', type: 'server_error' } })
    }

    default: {
      return json(401, { error: { message: 'Invalid API key', type: 'authentication_error', code: 'invalid_api_key' } })
    }
  }
}

const openaiQuotaFrame = () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 180

  return JSON.stringify({
    type: 'error',
    error: {
      type: 'usage_limit_reached',
      message: 'The usage limit has been reached',
      plan_type: 'prolite',
      resets_at: resetsAt,
      resets_in_seconds: 180,
    },
    status_code: 429,
    headers: { 'X-Codex-Primary-Used-Percent': '100', 'X-Codex-Primary-Reset-At': String(resetsAt) },
  })
}

export default Plugin.define({
  id: 'reparto-fault',
  setup: async (ctx) => {
    await ctx.session.hook('http.response', (request) => {
      if (request.kind !== 'primary') {
        return
      }

      const kind = take(String(request.model.providerID), String(request.agent))

      if (kind) {
        request.response = response(kind)
      }
    })
    await ctx.session.hook('experimental.ws.receive', (request) => {
      if (request.kind !== 'primary') {
        return
      }

      const kind = take(String(request.model.providerID), String(request.agent))

      if (kind) {
        request.frame = openaiQuotaFrame()
      }
    })
  },
})
