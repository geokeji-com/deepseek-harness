/** Ownerless V2 PTC logs are refused before any migration publication. */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath } from '../src/format.ts'

const userMessage = {
  id: 'tools-code-mode:user', role: 'user', source: { kind: 'user' },
  content: [{ type: 'text', text: 'Keep tools-code-mode and tool/code-dispatch in this text. 图片' }],
}
const titleMessage = {
  id: 'tools-code-mode:title-input', role: 'user',
  source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
  content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages:\n[{"seq":2,"text":"Keep tools-code-mode and tool/code-dispatch in this text. 图片"}]' }],
}
const toolCall = {
  type: 'tool-call', id: 'tools-code-mode:root-call', name: 'run_code',
  arguments: '{"code":"return tools.read_image(input)","literal":"tools-code-mode"}',
}
const replayState = {
  response: { id: 'tools-code-mode:response', opaque: 'tool/code-dispatch' },
  blocks: [{ signature: 'tools-code-mode:signature' }],
}
const assistantMessage = {
  id: 'tools-code-mode:assistant', role: 'assistant', content: [toolCall],
  source: { kind: 'model', provider: 'historical', model: 'historical-model', replayState },
}
const toolMessage = {
  id: 'tools-code-mode:result', role: 'user',
  source: { kind: 'tool', callId: toolCall.id },
  content: [{
    type: 'tool-result', toolCallId: toolCall.id, isError: false,
    content: [{ type: 'text', text: 'tools-code-mode: image attached; tool/code-dispatch' }],
  }],
}
const imageMessage = {
  id: 'tools-code-mode:root-call:image-context', role: 'user',
  source: { kind: 'plugin', plugin: 'tools-code-mode', form: 'notice', summary: 'Image from tools-code-mode' },
  content: [
    { type: 'text', text: 'Image from tools-code-mode:child-call (tool/code-dispatch)' },
    { type: 'image', attachment: {
      attachmentId: 'tools-code-mode:image', mediaType: 'image/png', bytes: 68,
      width: 1, height: 1, name: 'tools-code-mode.png',
      originalDimensions: { width: 2, height: 2 },
    } },
  ],
}
const dispatch = {
  rootCallId: toolCall.id, parentCallId: toolCall.id, subCallId: 'tools-code-mode:child-call',
  name: 'read_image', arguments: { path: 'tools-code-mode.png', literal: 'tool/code-dispatch-start' },
}

/** Historical rows are literal V2 data, independent of the current event-name vocabulary. */
function releasedV2Events(): SessionFormatEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1001, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1002, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1003, data: userMessage, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 3, time: 1005, surfaceOp: 'append', data: {
      turn: 1, step: 1, message: assistantMessage,
      stream: [
        { type: 'tool-call-chunks', time0: 1004, index: 0, id: toolCall.id,
          name: toolCall.name, dt: [], args: [toolCall.arguments] },
        { type: 'chunk', time: 1005, chunk: { type: 'finish', reason: { kind: 'tool-calls' }, replayState } },
      ],
    } },
    { type: 'tool/call', seq: 4, time: 1006, data: {
      turn: 1, step: 1, callId: toolCall.id, name: toolCall.name, arguments: toolCall.arguments,
    } },
    { type: 'tool/code-dispatch-start', seq: 5, time: 1007, data: dispatch },
    { type: 'tool/code-dispatch', seq: 6, time: 1008, data: {
      ...dispatch, isError: false, content: imageMessage.content,
    } },
    { type: 'tool/result', seq: 7, time: 1009, surfaceOp: 'append', data: {
      turn: 1, step: 1, message: toolMessage,
    } },
    { type: 'agent/inbox/spliced', seq: 8, time: 1010, data: {
      target: 'next-step', start: 0, removedCount: 0, inserted: [imageMessage],
    } },
    { type: 'user/message', seq: 9, time: 1011, data: imageMessage, surfaceOp: 'append' },
    { type: 'session/title-llm-request', seq: 10, time: 1012, data: {
      titleProvider: 'tools-code-mode:title', messageSeqs: [2],
      route: { provider: 'historical', model: 'historical-model' },
      system: 'Keep tools-code-mode literal.', maxTokens: 32,
      messages: [titleMessage],
    } },
    { type: 'step/end', seq: 11, time: 1013, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 12, time: 1014, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('JSONL V2 PTC publication and restore', () => {
  let root: string | undefined
  let ctx: Context | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-v2-ptc-'))
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })

  afterEach(async () => {
    try {
      await ctx?.fiber.dispose()
    } finally {
      if (root !== undefined) await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses V2 PTC data without changing bytes or publishing a successor', async () => {
    if (root === undefined || ctx === undefined) throw new Error('persistence fixture is not initialized')
    const id = SessionId('tools-code-mode:session')
    const header = { type: 'session', version: 2, id, createdAt: 1000, isSeeded: false, delegationDepth: 0 }
    const events = releasedV2Events()
    const source = Buffer.from([header, ...events].map(row => JSON.stringify(row)).join('\n') + '\n')
    const predecessor = generationLogPath(root, undefined, id, 2, 'none')
    await mkdir(dirname(predecessor), { recursive: true })
    await writeFile(predecessor, source)
    const sourceStat = await stat(predecessor)

    for (const access of ['read', 'write'] as const) {
      const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => {
        await handle.close()
      })
      await expect(opened).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
      await expect(opened).rejects.toThrow('owner-aware migration tool')
    }
    expect(await readFile(predecessor)).toEqual(source)
    expect(await stat(predecessor)).toMatchObject({ dev: sourceStat.dev, ino: sourceStat.ino })
    expect((await readdir(dirname(predecessor))).filter(name => name.endsWith('.jsonl')).sort())
      .toEqual(['session.v2.jsonl'])
  })
})
