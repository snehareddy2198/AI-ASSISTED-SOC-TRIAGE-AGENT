import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

export const alertSchema = z.object({
  source: z.string().trim().min(1).max(100),
  sourceEventId: z.string().trim().max(200).optional(),
  timestamp: z.string().datetime({ offset: true }),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(5000).default(''),
  severity: z.enum(['Critical', 'High', 'Medium', 'Low']),
  entities: z.array(z.string().trim().min(1).max(256)).min(1).max(50),
  technique: z.string().trim().max(100).default(''),
})

const severityRank = { Critical: 4, High: 3, Medium: 2, Low: 1 }
const severityPoints = { Critical: 66, High: 49, Medium: 32, Low: 16 }
const aliases = {
  source: ['source', 'vendor', 'product', 'devicevendor', 'tool'],
  sourceEventId: ['sourceeventid', 'eventid', 'alertid', 'id'],
  timestamp: ['timestamp', 'time', 'eventtime', 'eventtimestamp', 'createdat', 'created', 'datetime'],
  title: ['title', 'name', 'alertname', 'displayname', 'rulename', 'eventname'],
  description: ['description', 'message', 'reason', 'summary'],
  severity: ['severity', 'priority', 'risk'],
  entities: ['entities', 'relatedentities', 'observables'],
  technique: ['technique', 'mitretechnique', 'techniqueid', 'attacktechnique'],
}

function keyOf(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function firstValue(record, names) {
  const accepted = new Set(names)
  for (const [key, value] of Object.entries(record)) {
    if (accepted.has(keyOf(key)) && value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function normalizeSeverity(value) {
  const severity = String(value ?? '').trim().toLowerCase()
  if (['critical', 'crit', 'sev0', 'sev 0', 'p1', 'emergency', 'urgent'].includes(severity)) return 'Critical'
  if (['high', 'sev1', 'sev 1', 'p2'].includes(severity)) return 'High'
  if (['medium', 'moderate', 'warning', 'warn', 'sev2', 'sev 2', 'p3'].includes(severity)) return 'Medium'
  if (['low', 'informational', 'info', 'sev3', 'sev 3', 'p4'].includes(severity)) return 'Low'
  return value
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString()
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const numeric = Number(value)
    const milliseconds = String(Math.trunc(numeric)).length <= 10 ? numeric * 1000 : numeric
    return new Date(milliseconds).toISOString()
  }
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function normalizeEntities(record, value) {
  if (Array.isArray(value)) {
    return value.map((entity) => {
      if (typeof entity === 'string') return entity.trim()
      if (entity && typeof entity === 'object') {
        const entityValue = entity.value ?? entity.name ?? entity.id
        return entityValue === undefined ? '' : `${entity.type ?? entity.kind ?? 'entity'}:${entityValue}`
      }
      return ''
    }).filter(Boolean)
  }
  if (typeof value === 'string' && value.trim()) return value.split(/[;|\n]/).map((entity) => entity.trim()).filter(Boolean)

  const fields = [
    ['user', ['user', 'username', 'account', 'principalname', 'userprincipalname', 'email', 'sourceusername']],
    ['host', ['host', 'hostname', 'device', 'devicename', 'devicehostname', 'computer']],
    ['ip', ['ip', 'sourceip', 'sourceipaddress', 'destinationip', 'destinationipaddress', 'clientip']],
    ['resource', ['resource', 'resourcename', 'asset', 'assetname', 'bucket']],
    ['domain', ['domain', 'hostnamevalue', 'url', 'destinationdomain']],
  ]
  const entities = []
  for (const [type, names] of fields) {
    const fieldValue = firstValue(record, names)
    if (typeof fieldValue === 'string' && fieldValue.trim()) entities.push(`${type}:${fieldValue.trim()}`)
  }
  return entities
}

export function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Each alert must be a JSON object or CSV row.')
  }

  const value = (field) => firstValue(record, aliases[field])
  const normalized = {
    source: String(value('source') ?? 'Imported source').trim(),
    sourceEventId: value('sourceEventId') === undefined ? undefined : String(value('sourceEventId')),
    timestamp: normalizeTimestamp(value('timestamp')),
    title: value('title') === undefined ? '' : String(value('title')),
    description: value('description') === undefined ? '' : String(value('description')),
    severity: normalizeSeverity(value('severity')),
    entities: normalizeEntities(record, value('entities')),
    technique: value('technique') === undefined ? '' : String(value('technique')),
  }
  return alertSchema.parse(normalized)
}

function digest(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 7).toUpperCase()
}

function severityFor(alerts) {
  return alerts.reduce((highest, alert) => severityRank[alert.severity] > severityRank[highest] ? alert.severity : highest, 'Low')
}

function ageLabel(timestamp, now) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

function entityType(value) {
  const prefix = value.split(':', 1)[0].toLowerCase()
  if (['user', 'account', 'identity', 'principal', 'email'].includes(prefix)) return 'identity'
  if (['host', 'device', 'endpoint', 'computer'].includes(prefix)) return 'endpoint'
  return 'cloud'
}

export function correlateAlerts(alerts, storyStates = {}, now = Date.now()) {
  if (alerts.length === 0) return []

  const sorted = [...alerts].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
  const parents = sorted.map((_, index) => index)
  const find = (index) => {
    let root = index
    while (parents[root] !== root) root = parents[root]
    while (parents[index] !== index) {
      const next = parents[index]
      parents[index] = root
      index = next
    }
    return root
  }
  const union = (left, right) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot
  }

  const previousByEntity = new Map()
  const windowMs = 60 * 60 * 1000
  sorted.forEach((alert, index) => {
    for (const entity of alert.entities) {
      const normalized = entity.trim().toLowerCase()
      const previous = previousByEntity.get(normalized)
      if (previous && Date.parse(alert.timestamp) - previous.time <= windowMs) union(index, previous.index)
      previousByEntity.set(normalized, { index, time: Date.parse(alert.timestamp) })
    }
  })

  const groups = new Map()
  sorted.forEach((alert, index) => {
    const root = find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(alert)
  })

  const stories = [...groups.values()].map((group) => {
    const entityCounts = new Map()
    for (const alert of group) {
      for (const entity of new Set(alert.entities.map((value) => value.trim().toLowerCase()))) {
        entityCounts.set(entity, (entityCounts.get(entity) ?? 0) + 1)
      }
    }
    const primaryEntity = [...entityCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0]
    const id = `ST-${digest(primaryEntity)}`
    const ordered = [...group].sort((left, right) => severityRank[right.severity] - severityRank[left.severity] || Date.parse(right.timestamp) - Date.parse(left.timestamp))
    const lead = ordered[0]
    const eventOrder = [...group].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    const sources = new Set(group.map((alert) => alert.source))
    const uniqueEntities = [...entityCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([entity]) => entity)
    const severity = severityFor(group)
    const factors = [
      { label: 'Severity', points: severityPoints[severity] },
      { label: 'Repeated evidence', points: Math.min(12, (group.length - 1) * 4) },
      { label: 'Multiple sources', points: Math.min(9, (sources.size - 1) * 3) },
      { label: 'Sensitive entity', points: /admin|finance|payment|production|prod|privileged/i.test(uniqueEntities.join(' ')) ? 8 : 0 },
      { label: 'Recent activity', points: now - Date.parse(eventOrder.at(-1).timestamp) <= 15 * 60_000 ? 5 : 0 },
    ]
    const score = Math.min(99, factors.reduce((total, factor) => total + factor.points, 0))
    const confidence = Math.min(98, 58 + Math.min(16, (group.length - 1) * 6) + Math.min(18, (sources.size - 1) * 9))
    const state = storyStates[id] ?? {}
    const technique = lead.technique || eventOrder.find((alert) => alert.technique)?.technique || 'Behavioral correlation'

    return {
      id,
      title: lead.title,
      summary: lead.description || `${group.length} related alert${group.length === 1 ? '' : 's'} correlated through ${primaryEntity}.`,
      severity,
      score,
      confidence,
      age: ageLabel(eventOrder[0].timestamp, now),
      alerts: group.length,
      sources: [...sources].sort(),
      entities: uniqueEntities,
      technique,
      path: [...new Set(eventOrder.map((alert) => alert.title))].slice(0, 4),
      status: state.status ?? 'Open',
      caseCreatedAt: state.caseCreatedAt ?? null,
      riskFactors: factors,
      evidence: eventOrder.map((alert) => ({
        time: new Date(alert.timestamp).toISOString().slice(11, 19),
        timestamp: alert.timestamp,
        source: alert.source,
        title: alert.title,
        detail: alert.description,
        type: alert.entities.map(entityType).find((type) => type === 'identity') ?? entityType(alert.entities[0]),
      })),
    }
  })

  return stories.sort((left, right) => right.score - left.score || right.alerts - left.alerts || left.id.localeCompare(right.id))
}

export function alertFingerprint(alert) {
  return alert.sourceEventId
    ? `${alert.source.toLowerCase()}:${alert.sourceEventId.toLowerCase()}`
    : digest(JSON.stringify([alert.source, alert.timestamp, alert.title, [...alert.entities].sort()]))
}

export function createDemoAlerts(now = Date.now()) {
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
  const samples = [
    ['Entra ID', 'entra-consent', 12, 'High', 'OAuth consent granted', 'A finance user approved an unfamiliar mail application.', ['user:m.chen', 'ip:203.0.113.48', 'app:Mail Sync Pro'], 'T1528'],
    ['Microsoft 365', 'm365-token', 9, 'Critical', 'Refresh token used from new network', 'The new application token was replayed from an unfamiliar network.', ['user:m.chen', 'ip:203.0.113.48', 'mailbox:m.chen'], 'T1528'],
    ['Microsoft 365', 'm365-rule', 6, 'Critical', 'External mailbox forwarding rule created', 'A hidden rule forwards invoice messages to an external address.', ['user:m.chen', 'mailbox:m.chen', 'domain:ledger-sync.example'], 'T1114'],
    ['GitHub Audit', 'github-runner', 24, 'High', 'Build runner credential used interactively', 'A production build identity authenticated outside an approved workflow.', ['principal:svc-build-prod', 'host:build-runner-07'], 'T1078.004'],
    ['AWS CloudTrail', 'aws-secrets', 20, 'High', 'Production secrets enumerated', 'The build identity listed secrets outside its usual deployment activity.', ['principal:svc-build-prod', 'resource:prod-secrets'], 'T1552'],
    ['Secure Email', 'email-phish', 36, 'Medium', 'Credential-harvest link opened by three users', 'Three recipients opened the same newly registered sign-in lookalike.', ['domain:signin-check.example', 'user:a.roberts', 'user:j.patel'], 'T1566.002'],
    ['Entra ID', 'entra-phish-login', 32, 'High', 'Risky sign-ins after phishing click', 'Two targeted users authenticated from a previously unseen network.', ['domain:signin-check.example', 'user:a.roberts', 'ip:198.51.100.24'], 'T1078'],
    ['Defender for Endpoint', 'defender-submit', 30, 'High', 'Browser credential submission to lookalike site', 'Browser telemetry recorded a credential form submission to the lookalike.', ['domain:signin-check.example', 'user:j.patel', 'host:HR-LT-022'], 'T1056.003'],
    ['Directory Audit', 'directory-reactivation', 52, 'Medium', 'Dormant contractor account re-enabled', 'The account was inactive for 94 days with no matching change request.', ['user:c.wells'], 'T1078'],
    ['Defender for Endpoint', 'defender-smb', 48, 'Medium', 'SMB access to two file servers', 'A newly observed host contacted two servers through administrative shares.', ['user:c.wells', 'host:ENG-LT-114', 'host:FS-02'], 'T1021.002'],
  ]

  return samples.map(([source, sourceEventId, minutesAgo, severity, title, description, entities, technique]) => ({
    id: randomUUID(), source, sourceEventId, timestamp: at(minutesAgo), severity, title, description, entities, technique,
  }))
}