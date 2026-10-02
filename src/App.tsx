import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { Activity, ArrowRight, Bell, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, Fingerprint, GitBranch, Globe2, Layers3, Plus, Search, Shield, ShieldAlert, Sparkles, Workflow, X, Zap } from 'lucide-react'
import './App.css'
import './dashboard.css'

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`)
  return payload as T
}

function App() {
  const [stories, setStories] = useState<Incident[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [view, setView] = useState<'triage' | 'integrations'>('triage')
  const [query, setQuery] = useState('')
  const [priority, setPriority] = useState('All priorities')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [caseCreated, setCaseCreated] = useState(false)
  const [apiStatus, setApiStatus] = useState<'loading' | 'online' | 'offline'>('loading')
  const [apiError, setApiError] = useState('')
  const [importing, setImporting] = useState(false)
  const [stats, setStats] = useState({ rawAlerts: 0, stories: 0, critical: 0, active: 0, sources: [] as string[], sourceCounts: {} as Record<string, number> })
  const fileInput = useRef<HTMLInputElement>(null)
  const selected = stories.find((story) => story.id === selectedId)
  const visible = stories.filter((story) => `${story.title} ${story.entities.join(' ')} ${story.id}`.toLowerCase().includes(query.toLowerCase()) && (priority === 'All priorities' || story.severity === priority))
  const activeCount = apiStatus === 'online' ? stats.active : stories.filter((story) => story.status !== 'Contained').length

  async function refreshDashboard() {
    try {
      const [storyPayload, nextStats] = await Promise.all([
        apiRequest<{ stories: Incident[] }>('/api/stories'),
        apiRequest<typeof stats>('/api/stats'),
      ])
      setStories(storyPayload.stories)
      setSelectedId((current) => storyPayload.stories.some((story) => story.id === current) ? current : storyPayload.stories[0]?.id ?? '')
      setStats(nextStats)
      setApiStatus('online')
      setApiError('')
      return storyPayload
    } catch (error) {
      setApiStatus('offline')
      setApiError(error instanceof Error ? error.message : 'Could not reach the local API.')
      return null
    }
  }

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refreshDashboard(), 0)
    const interval = window.setInterval(() => void refreshDashboard(), 15_000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(interval)
    }
  }, [])

  function notify(message: string) {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2500)
  }

  async function toggleContainment() {
    if (!selected) return
    const status = selected.status === 'Contained' ? 'Investigating' : 'Contained'
    try {
      await apiRequest(`/api/stories/${selected.id}/status`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }),
      })
      await refreshDashboard()
      notify(status === 'Contained' ? 'Story marked contained' : 'Investigation reopened')
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not update story status.') }
  }

  async function createCase() {
    if (!selected) return
    try {
      await apiRequest(`/api/stories/${selected.id}/case`, { method: 'POST' })
      setCaseCreated(true)
      await refreshDashboard()
      notify(`Case ${selected.id} created`)
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not create case.') }
  }

  async function runCorrelation() {
    const result = await refreshDashboard()
    if (result) notify(`Correlation complete · ${result.stories.length} stories ranked`)
  }

  async function copyIngestEndpoint() {
    const endpoint = `${window.location.origin}/api/alerts`
    try {
      await navigator.clipboard.writeText(endpoint)
      notify('Ingest endpoint copied')
    } catch { notify(endpoint) }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setImporting(true)
    try {
      const csv = file.name.toLowerCase().endsWith('.csv')
      const result = await apiRequest<{ accepted: number; duplicates: number }>('/api/alerts', {
        method: 'POST',
        headers: { 'content-type': csv ? 'text/csv' : 'application/json' },
        body: await file.text(),
      })
      await refreshDashboard()
      notify(`${result.accepted} alerts imported · ${result.duplicates} duplicates skipped`)
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not import this file.') }
    finally { setImporting(false) }
  }

  return (
    <div className="app-shell">
      <header className="topbar"><a className="brand" href="#home" onClick={() => setView('triage')}><span className="brand-mark"><Workflow size={18} /></span>signal<span className="brand-light">loom</span></a><span className="top-divider" /><button className="tenant" onClick={() => notify('Local workspace selected')}><i />Local workspace<ChevronDown size={14} /></button><div className="top-actions"><span className={`demo-tag ${apiStatus === 'offline' ? 'api-offline' : ''}`}><i />{apiStatus === 'loading' ? 'CONNECTING' : apiStatus === 'offline' ? 'API OFFLINE' : 'LOCAL MVP'}</span><button className="icon-button" aria-label="Notifications" onClick={() => notify('You are all caught up')}><Bell size={17} /></button><button className="avatar" aria-label="User profile" onClick={() => notify('Signal Loom local workspace')}>SL</button></div></header>
      <div className="layout">
        <aside className="sidebar"><span className="side-label">WORKSPACE</span><nav>
          <button className={view === 'triage' ? 'nav-button selected' : 'nav-button'} onClick={() => setView('triage')}><Activity size={16} /><span>Triage</span><b>{activeCount}</b></button>
          <button className="nav-button" onClick={() => setView('triage')}><GitBranch size={16} /><span>Attack stories</span></button>
          <button className={view === 'integrations' ? 'nav-button selected' : 'nav-button'} onClick={() => setView('integrations')}><Layers3 size={16} /><span>Data sources</span><b className="quiet-count">{stats.sources.length}</b></button>
        </nav><span className="side-label health-label">SIGNAL HEALTH</span><div className="health"><i className={apiStatus === 'online' ? 'healthy' : 'unhealthy'} />Correlation engine <small>{apiStatus === 'online' ? 'Live' : apiStatus === 'loading' ? 'Checking' : 'Offline'}</small></div><div className="health"><i className={apiStatus === 'online' ? 'healthy' : 'unhealthy'} />Ingestion pipeline <small>{apiStatus === 'online' ? 'Live' : apiStatus === 'loading' ? 'Checking' : 'Offline'}</small></div><div className="sidebar-bottom"><div className="lookback"><span><Clock3 size={13} /> LOOKBACK WINDOW</span><strong>Last 24 hours</strong><small>Updated just now</small></div><button className="help-link" onClick={() => notify('Signal Loom local workspace')}><CircleHelp size={15} /> Help & feedback</button><div className="version"><span>Signal Loom</span><span>v0.1.0</span></div></div></aside>
        <main className="main-content"><div className="content-wrap">
          <div className="eyebrow">SECURITY OPERATIONS <ChevronRight size={12} /> {view === 'integrations' ? 'DATA SOURCES' : 'TRIAGE WORKSPACE'}</div>
          <div className="heading-row"><div><h1>{view === 'integrations' ? 'Data sources' : 'Triage, by attack path'}</h1><p>{view === 'integrations' ? 'Review sources represented in the imported alert data.' : 'One incident story, not a hundred disconnected alerts.'}</p></div>{view === 'triage' && <div className="heading-actions"><input ref={fileInput} className="file-input" type="file" accept=".json,.csv,application/json,text/csv" onChange={importFile} /><button className="import-button" disabled={importing || apiStatus !== 'online'} onClick={() => fileInput.current?.click()}><Plus size={14} />{importing ? 'Importing…' : 'Import alerts'}</button><button className="run-button" disabled={apiStatus !== 'online'} onClick={runCorrelation}><Sparkles size={14} />Correlate now</button></div>}</div>
          {apiError && <div className="api-warning" role="alert"><ShieldAlert size={16} /><span><strong>Local API unavailable</strong><small>{apiError} Start the project with <code>npm run dev</code>.</small></span><button onClick={() => void refreshDashboard()}>Retry</button></div>}
          {view === 'integrations' ? <section className="integrations"><div className="integration-intro"><div className="integration-icon"><Layers3 size={19} /></div><div><strong>Alert intake</strong><span>JSON batches and CSV files · up to 5,000 alerts per request</span></div><button className="outline-button" onClick={copyIngestEndpoint}>Copy endpoint</button></div><div className="endpoint-row"><code>POST {window.location.origin}/api/alerts</code><span>Local · validated · deduplicated</span></div><div className="source-list-title">OBSERVED SOURCES <span>{stats.sources.length}</span></div>{stats.sources.length ? stats.sources.map((name) => <div className="connector" key={name}><div className="connector-icon"><Activity size={17} /></div><div className="connector-name"><strong>{name}</strong><span>{stats.sourceCounts[name] ?? 0} stored alerts</span></div><span className="connected"><i />Observed</span></div>) : <div className="empty">No alerts ingested yet. Import a JSON or CSV file from Triage.</div>}</section> : <>
            <section className="metrics"><div><span>RAW ALERTS</span><strong>{stats.rawAlerts}</strong><small><ArrowRight size={12} /> {stats.sources.length} reporting sources</small></div><div><span>ATTACK STORIES</span><strong>{stats.stories}</strong><small><GitBranch size={12} /> correlated from current signals</small></div><div><span>NEED ATTENTION</span><strong className="critical-count">{stats.critical} <em>critical</em></strong><small><ShieldAlert size={12} /> {activeCount} active investigations</small></div><div className="context-metric"><span className="signal-bars">▂ ▄ ▇ ▅ █ ▄ ▆</span><div><strong>Context over volume</strong><small>Shared entities and time windows link related signals.</small></div></div></section>
            <div className="queue-toolbar"><div className="queue-title"><i />Ranked investigations <span>{visible.length} of {stories.length}</span></div><div className="filters"><label><Search size={14} /><input placeholder="Search stories or entities" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>/</kbd></label><select aria-label="Filter by priority" value={priority} onChange={(event) => setPriority(event.target.value)}><option>All priorities</option><option>Critical</option><option>High</option><option>Medium</option></select></div></div>
            <div className="triage-grid"><section className="story-list"><div className="list-head"><span>STORY / SIGNALS</span><span>RISK</span></div>{visible.length ? visible.map((story) => <button className={`story-row ${selectedId === story.id ? 'active-story' : ''}`} key={story.id} onClick={() => { setSelectedId(story.id); setExpanded(null); setCaseCreated(Boolean(story.caseCreatedAt)) }}><i className={`severity-bar ${story.severity.toLowerCase()}`} /><span className="story-text"><strong>{story.title}</strong><small>{story.id} · {story.alerts} signals · {story.age}</small><em>{story.entities.slice(0, 2).join(' / ')}</em></span><span className="risk-value"><strong>{story.score}</strong><small>{story.severity}</small></span></button>) : <div className="empty">{apiStatus === 'loading' ? 'Loading correlated stories…' : 'No matching stories'}<button onClick={() => { setQuery(''); setPriority('All priorities') }}>Clear filters</button></div>}<div className="list-footer"><span><i /> LOCAL STORE · {stats.rawAlerts} ALERTS</span><button onClick={runCorrelation}>Refresh signals <ArrowRight size={12} /></button></div></section>
            {selected && <section className="detail"><div className="detail-top"><span className={`severity-pill ${selected.severity.toLowerCase()}`}><i />{selected.severity} priority</span><small>{selected.id}</small><button className="close-detail" aria-label="Dismiss detail" onClick={() => setSelectedId('')}><X size={15} /></button></div><h2>{selected.title}</h2><p className="summary">{selected.summary}</p>
              <div className="facts"><div className="score"><span className="score-circle" style={{ '--score': `${selected.score}%` } as CSSProperties}><span>{selected.score}</span></span><span><small>RISK SCORE</small><strong>{selected.score > 85 ? 'Act now' : 'Investigate'}</strong></span></div><div><small>CORRELATION CONFIDENCE</small><strong>{selected.confidence}%</strong><span className="confidence"><i style={{ width: `${selected.confidence}%` }} /></span></div><div><small>FIRST SIGNAL</small><strong><Clock3 size={13} />{selected.age}</strong></div></div>
              <div className="section-title"><span>OBSERVED ATTACK PATH</span><small>{selected.technique}</small></div><div className="attack-path">{selected.path.map((step, index) => <div className="path-item" key={step}><span className={index === selected.path.length - 1 ? 'path-node current-node' : 'path-node'}>{index === selected.path.length - 1 ? <Zap size={12} /> : <Check size={12} />}</span><small>{step}</small>{index < selected.path.length - 1 && <ArrowRight size={12} />}</div>)}</div>
              <div className="section-title evidence-title"><span>LINKED EVIDENCE</span><small>{selected.alerts} signals · {selected.evidence.length} key events</small><button onClick={() => setExpanded(expanded ? null : 'all')}>{expanded ? 'Collapse all' : 'Expand all'}<ChevronDown size={12} /></button></div>
              <div className="evidence">{selected.evidence.map((event, index) => { const expandedEvent = expanded === 'all' || expanded === event.title; const Icon = event.type === 'identity' ? Fingerprint : event.type === 'endpoint' ? Shield : Globe2; return <button className="event" key={event.title} onClick={() => setExpanded(expandedEvent ? null : event.title)}><span className={`event-icon ${event.type}`}><Icon size={13} /></span><span className="event-info"><span><strong>{event.title}</strong><time>{event.time}</time></span><small>{event.source}</small>{expandedEvent && <em>{event.detail}</em>}</span><ChevronDown className={expandedEvent ? 'turned' : ''} size={13} />{index < selected.evidence.length - 1 && <i className="event-line" />}</button> })}</div>
              <div className="section-title entity-title"><span>INVOLVED ENTITIES</span><small>{selected.entities.length}</small></div><div className="entities">{selected.entities.map((entity) => <span key={entity}><i />{entity}</span>)}</div><div className="explanation"><Sparkles size={14} /><span><strong>Why ranked #{stories.findIndex((story) => story.id === selectedId) + 1}</strong><small>{selected.riskFactors.filter((factor) => factor.points > 0).map((factor) => `${factor.label} +${factor.points}`).join(' · ')}</small></span><ChevronRight size={14} /></div>
              <div className="detail-actions"><button className="contain" disabled={apiStatus !== 'online'} onClick={toggleContainment}><Shield size={14} />{selected.status === 'Contained' ? 'Reopen investigation' : 'Mark contained'}</button><button className="create-case" disabled={apiStatus !== 'online'} onClick={createCase}>{caseCreated || selected.caseCreatedAt ? <Check size={14} /> : <Plus size={14} />}{caseCreated || selected.caseCreatedAt ? 'Case created' : 'Create case'}</button><span className={`status ${selected.status.toLowerCase()}`}><i />{selected.status}</span></div>
            </section>}</div><footer className="page-footer"><span>Signals correlated across identity, endpoint & cloud</span><span>Last correlation <strong>just now</strong></span></footer>
          </>}
        </div></main>
      </div>
      {notice && <div className="toast" role="status"><CheckCircle2 size={16} />{notice}<button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={14} /></button></div>}
    </div>
  )
}

type Event = { time: string; timestamp: string; source: string; title: string; detail: string; type: 'identity' | 'endpoint' | 'cloud' }
type Incident = { id: string; title: string; summary: string; severity: 'Critical' | 'High' | 'Medium' | 'Low'; score: number; confidence: number; age: string; alerts: number; sources: string[]; entities: string[]; technique: string; path: string[]; status: 'Investigating' | 'Contained' | 'Open'; caseCreatedAt?: string | null; riskFactors: { label: string; points: number }[]; evidence: Event[] }

export default App
