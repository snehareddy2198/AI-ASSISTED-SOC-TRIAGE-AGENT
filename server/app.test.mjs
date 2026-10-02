import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from './app.mjs'
import { createStore } from './store.mjs'

test('ingests, correlates, deduplicates, and persists security alerts', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'signal-loom-'))
  const storePath = join(directory, 'store.json')
  const server = createServer(createApp({ store: createStore({ filePath: storePath, seed: () => [] }) }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  })

  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const timestamp = new Date().toISOString()
  const batch = [
    { source: 'Entra', sourceEventId: 'entra-1', timestamp, severity: 'High', title: 'Unfamiliar sign-in', entities: ['user:analyst@example.test', 'ip:192.0.2.40'] },
    { source: 'EDR', sourceEventId: 'edr-2', timestamp, severity: 'Critical', title: 'Suspicious process', description: 'Process was blocked.', entities: ['user:analyst@example.test', 'host:workstation-4'] },
    { source: 'Cloud', sourceEventId: 'cloud-3', timestamp, severity: 'Low', title: 'Unrelated bucket event', entities: ['resource:public-assets'] },
  ]
  const ingest = await fetch(`${baseUrl}/api/alerts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alerts: batch }),
  })
  assert.equal(ingest.status, 201)
  assert.deepEqual(await ingest.json(), { received: 3, accepted: 3, duplicates: 0, total: 3 })

  const storyResponse = await fetch(`${baseUrl}/api/stories`)
  const { stories } = await storyResponse.json()
  assert.equal(stories.length, 2)
  const correlated = stories.find((story) => story.alerts === 2)
  assert.equal(correlated.severity, 'Critical')
  assert.ok(correlated.riskFactors.some((factor) => factor.label === 'Multiple sources'))
  const stats = await (await fetch(`${baseUrl}/api/stats`)).json()
  assert.deepEqual(stats.sourceCounts, { Entra: 1, EDR: 1, Cloud: 1 })

  const duplicate = await fetch(`${baseUrl}/api/alerts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch[0]),
  })
  assert.deepEqual(await duplicate.json(), { received: 1, accepted: 0, duplicates: 1, total: 3 })

  const invalidBatch = await fetch(`${baseUrl}/api/alerts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alerts: [batch[0], { ...batch[2], title: '' }] }),
  })
  assert.equal(invalidBatch.status, 400)
  assert.equal((await (await fetch(`${baseUrl}/api/alerts`)).json()).total, 3)

  const statusUpdate = await fetch(`${baseUrl}/api/stories/${correlated.id}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'Contained' }),
  })
  assert.equal(statusUpdate.status, 200)
  const caseResponse = await fetch(`${baseUrl}/api/stories/${correlated.id}/case`, { method: 'POST' })
  assert.equal(caseResponse.status, 201)

  const csvResponse = await fetch(`${baseUrl}/api/alerts`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv' },
    body: `source,sourceEventId,timestamp,severity,title,description,entities,technique\nCrowdStrike,csv-4,${timestamp},sev2,CSV imported signal,Imported from CSV,user:csv-account;host:csv-host,T1059`,
  })
  assert.equal(csvResponse.status, 201)
  assert.equal((await csvResponse.json()).accepted, 1)

  const malformedCsv = await fetch(`${baseUrl}/api/alerts`, {
    method: 'POST', headers: { 'content-type': 'text/csv' },
    body: 'source,severity,title,entities\n"unterminated,High,Invalid row,user:bad',
  })
  assert.equal(malformedCsv.status, 400)

  const reopenedStore = createStore({ filePath: storePath, seed: () => [] })
  const persisted = await reopenedStore.read()
  assert.equal(persisted.alerts.length, 4)
  assert.equal(persisted.storyStates[correlated.id].status, 'Contained')
  assert.ok(persisted.storyStates[correlated.id].caseCreatedAt)
  assert.equal(persisted.alerts.find((alert) => alert.sourceEventId === 'csv-4').severity, 'Medium')
})