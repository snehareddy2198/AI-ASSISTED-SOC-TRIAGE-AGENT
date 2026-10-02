import { randomUUID } from 'node:crypto'
import express from 'express'
import { parse } from 'csv-parse/sync'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { alertFingerprint, correlateAlerts, normalizeRecord } from './domain.mjs'
import { createStore } from './store.mjs'

const statusSchema = z.object({ status: z.enum(['Open', 'Investigating', 'Contained']) })
const maxBatchSize = 5000

function inputRecords(body, contentType) {
  if (typeof body === 'string' && contentType.includes('csv')) {
    return parse(body, { columns: true, skip_empty_lines: true, bom: true, trim: true, max_record_size: 16_384 })
  }
  if (Array.isArray(body)) return body
  if (body && Array.isArray(body.alerts)) return body.alerts
  if (body && typeof body === 'object') return [body]
  throw new Error('Send one alert, an array of alerts, { "alerts": [...] }, or a CSV file.')
}

function validationMessage(error, index) {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `Alert ${index + 1}: ${issue.path.join('.') || 'record'} ${issue.message}`).join('; ')
  }
  return `Alert ${index + 1}: ${error.message}`
}

export function createApp({ store = createStore(), serveClient = false } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use('/api', express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }))
  app.use('/api', express.text({ limit: '2mb', type: ['text/csv', 'application/csv', 'text/plain'] }))

  app.get('/api/health', async (_request, response, next) => {
    try {
      const state = await store.read()
      response.json({ status: 'ok', alertCount: state.alerts.length, timestamp: new Date().toISOString() })
    } catch (error) { next(error) }
  })

  app.get('/api/stories', async (_request, response, next) => {
    try {
      const state = await store.read()
      response.json({ stories: correlateAlerts(state.alerts, state.storyStates) })
    } catch (error) { next(error) }
  })

  app.get('/api/stats', async (_request, response, next) => {
    try {
      const state = await store.read()
      const stories = correlateAlerts(state.alerts, state.storyStates)
      const sourceCounts = state.alerts.reduce((counts, alert) => {
        counts[alert.source] = (counts[alert.source] ?? 0) + 1
        return counts
      }, {})
      response.json({
        rawAlerts: state.alerts.length,
        stories: stories.length,
        critical: stories.filter((story) => story.severity === 'Critical' && story.status !== 'Contained').length,
        active: stories.filter((story) => story.status !== 'Contained').length,
        sources: [...new Set(state.alerts.map((alert) => alert.source))].sort(),
        sourceCounts,
      })
    } catch (error) { next(error) }
  })

  app.get('/api/alerts', async (request, response, next) => {
    try {
      const state = await store.read()
      const limit = Math.min(500, Math.max(1, Number.parseInt(request.query.limit, 10) || 100))
      response.json({ alerts: [...state.alerts].sort((left, right) => right.timestamp.localeCompare(left.timestamp)).slice(0, limit), total: state.alerts.length })
    } catch (error) { next(error) }
  })

  app.post('/api/alerts', async (request, response, next) => {
    try {
      const records = inputRecords(request.body, request.get('content-type') ?? '')
      if (records.length === 0) return response.status(400).json({ error: 'The import contains no alert records.' })
      if (records.length > maxBatchSize) return response.status(413).json({ error: `A single import is limited to ${maxBatchSize} alerts.` })

      const alerts = records.map((record, index) => {
        try { return normalizeRecord(record) } catch (error) { throw new Error(validationMessage(error, index)) }
      })

      const result = await store.update((state) => {
        const known = new Set(state.alerts.map(alertFingerprint))
        let accepted = 0
        let duplicates = 0
        for (const alert of alerts) {
          const fingerprint = alertFingerprint(alert)
          if (known.has(fingerprint)) { duplicates += 1; continue }
          known.add(fingerprint)
          state.alerts.push({ ...alert, id: randomUUID() })
          accepted += 1
        }
        return { received: alerts.length, accepted, duplicates, total: state.alerts.length }
      })

      response.status(201).json(result)
    } catch (error) {
      if (typeof error.code === 'string' && error.code.startsWith('CSV_')) {
        return response.status(400).json({ error: 'CSV is malformed. Check the header, quoting, and row column counts.' })
      }
      if (error.name === 'ZodError' || error.message.startsWith('Alert ') || error.message.startsWith('Send ')) {
        return response.status(400).json({ error: error.message })
      }
      next(error)
    }
  })

  app.patch('/api/stories/:id/status', async (request, response, next) => {
    try {
      const { status } = statusSchema.parse(request.body)
      const state = await store.read()
      const stories = correlateAlerts(state.alerts, state.storyStates)
      if (!stories.some((story) => story.id === request.params.id)) return response.status(404).json({ error: 'Story not found.' })
      await store.update((current) => {
        current.storyStates[request.params.id] = { ...current.storyStates[request.params.id], status }
      })
      response.json({ id: request.params.id, status })
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: 'Status must be Open, Investigating, or Contained.' })
      next(error)
    }
  })

  app.post('/api/stories/:id/case', async (request, response, next) => {
    try {
      const state = await store.read()
      if (!correlateAlerts(state.alerts, state.storyStates).some((story) => story.id === request.params.id)) {
        return response.status(404).json({ error: 'Story not found.' })
      }
      const caseCreatedAt = new Date().toISOString()
      await store.update((current) => {
        current.storyStates[request.params.id] = { ...current.storyStates[request.params.id], caseCreatedAt }
      })
      response.status(201).json({ id: request.params.id, caseCreatedAt })
    } catch (error) { next(error) }
  })

  app.post('/api/demo/reset', async (_request, response, next) => {
    try { response.json(await store.reset()) } catch (error) { next(error) }
  })

  if (serveClient) {
    const clientDirectory = fileURLToPath(new URL('../dist/', import.meta.url))
    const indexFile = fileURLToPath(new URL('../dist/index.html', import.meta.url))
    app.use(express.static(clientDirectory))
    app.use((request, response, next) => {
      if (request.method === 'GET' && !request.path.startsWith('/api/')) {
        return response.sendFile(indexFile)
      }
      next()
    })
  }

  app.use((error, _request, response, _next) => {
    if (error.type === 'entity.too.large') return response.status(413).json({ error: 'Request body exceeds the 2 MB limit.' })
    if (error.type === 'entity.parse.failed') return response.status(400).json({ error: 'Request body must contain valid JSON.' })
    response.status(500).json({ error: 'Internal server error.' })
  })

  return app
}