/**
 * `slack.notify` — the one action tool in the belt (Layer 3 in the plan).
 * Everything else here reads; this is the only tool that writes somewhere a
 * human will see it. One `fetch` POST to an incoming webhook URL — no OAuth,
 * no SDK, no scopes to request.
 *
 * The three-mode discipline still holds, but shaped differently than the
 * read connectors: there is no fixture to replay for an outbound write (a
 * "recorded" Slack post is a contradiction — either it happened or it
 * didn't), so this tool only ever reports `live` or `unconfigured`, never
 * `fixture`. And `status()` deliberately does NOT fire a real test message
 * to check — unlike the read connectors, whose `status()` calls are
 * idempotent GETs, probing this one for real would post a message to a real
 * channel on every dashboard load. `status()` reports whether the tool is
 * configured to attempt a live call, not that one already succeeded.
 */

import { registerTool, type ToolResult } from '../registry'
import { attemptLive } from '../fixtures/cassette'

export type SlackNotifyInput = { text: string }
export type SlackNotifyOutput = { posted: true }

async function postToSlack(webhookUrl: string, text: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) throw new Error(`Slack webhook ${res.status}`)
}

async function handleNotify(input: SlackNotifyInput): Promise<ToolResult<SlackNotifyOutput>> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    return { mode: 'unconfigured', data: null, reason: 'SLACK_WEBHOOK_URL not set' }
  }

  const attempt = await attemptLive(() => postToSlack(webhookUrl, input.text))
  if (attempt.ok) {
    return { mode: 'live', data: { posted: true } }
  }
  return { mode: 'live', data: null, reason: attempt.error }
}

registerTool<SlackNotifyInput, SlackNotifyOutput>({
  name: 'slack.notify',
  description: 'Post a message to the configured Slack channel — e.g. a run finished, or a new exception needs review.',
  schema: {
    type: 'object',
    required: ['text'],
    properties: { text: { type: 'string', description: 'Plain-text message body.' } },
  },
  requiredEnv: 'SLACK_WEBHOOK_URL',
  handler: handleNotify,
  status: async () => (process.env.SLACK_WEBHOOK_URL ? 'live' : 'unconfigured'),
})

/** For the dashboard: fire-and-forget, never throws into the caller's run. */
export async function notifySlack(text: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) return
  await attemptLive(() => postToSlack(webhookUrl, text))
}
