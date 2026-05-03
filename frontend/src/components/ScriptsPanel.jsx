import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getScripts, getScriptTemplate, createScript,
  updateScript, deleteScript, validateScript,
} from '../api/client'
import {
  CodeBracketIcon, PlusIcon, TrashIcon,
  CheckCircleIcon, XCircleIcon, DocumentTextIcon,
} from '@heroicons/react/24/outline'

// --------------------------------------------------------------------------- #
// Function reference sidebar
// --------------------------------------------------------------------------- #

const FUNCTION_DOCS = [
  {
    sig: 'get_default_params() -> dict',
    desc: 'Return a dict of default parameter values. These are passed as keyword arguments to generate_signals when no overrides are provided.',
    optional: true,
  },
  {
    sig: 'generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame',
    desc: 'Core signal generation function. Receives OHLCV data (columns: Open, High, Low, Close, Volume) and must return the DataFrame with a "signal" column added: +1 = buy, -1 = sell, 0 = hold.',
    optional: false,
  },
]

function FunctionReference() {
  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
        Overridable Functions
      </h3>
      {FUNCTION_DOCS.map((fn) => (
        <div key={fn.sig} className="bg-dark-900/60 border border-dark-500 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <CodeBracketIcon className="h-4 w-4 text-emerald-400 flex-shrink-0" />
            <code className="text-xs text-emerald-300 font-mono break-all">{fn.sig}</code>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">{fn.desc}</p>
          {fn.optional && (
            <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400">
              optional
            </span>
          )}
          {!fn.optional && (
            <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400 border border-emerald-700/30">
              required
            </span>
          )}
        </div>
      ))}
      <div className="bg-dark-900/60 border border-dark-500 rounded-lg p-3 space-y-1.5">
        <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide">
          Allowed imports
        </div>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {['pandas (pd)', 'numpy (np)', 'math', 'statistics'].map(m => (
            <code key={m} className="text-xs bg-dark-700 text-slate-300 px-1.5 py-0.5 rounded font-mono">
              {m}
            </code>
          ))}
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- #
// Main panel
// --------------------------------------------------------------------------- #

export default function ScriptsPanel() {
  const qc = useQueryClient()

  const [selectedId, setSelectedId] = useState(null)
  const [draftName, setDraftName] = useState('')
  const [draftDesc, setDraftDesc] = useState('')
  const [draftCode, setDraftCode] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [validationResult, setValidationResult] = useState(null)
  const [saveMsg, setSaveMsg] = useState(null)
  const [showNewForm, setShowNewForm] = useState(false)
  const [newName, setNewName] = useState('')

  const { data: scriptsData, isLoading: scriptsLoading } = useQuery({
    queryKey: ['scripts'],
    queryFn: getScripts,
  })

  const { data: templateData } = useQuery({
    queryKey: ['script-template'],
    queryFn: getScriptTemplate,
  })

  const scripts = scriptsData?.scripts ?? []
  const selectedScript = scripts.find(s => s.id === selectedId) ?? null

  // Populate editor when selection changes
  useEffect(() => {
    if (selectedScript) {
      setDraftName(selectedScript.name)
      setDraftDesc(selectedScript.description ?? '')
      setDraftCode(selectedScript.script_code)
      setIsDirty(false)
      setValidationResult(null)
      setSaveMsg(null)
    }
  }, [selectedScript])

  const saveMut = useMutation({
    mutationFn: ({ id, payload }) => updateScript(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scripts'] })
      setIsDirty(false)
      setSaveMsg({ type: 'success', text: 'Script saved.' })
    },
    onError: (err) => {
      setSaveMsg({ type: 'error', text: err.response?.data?.detail || err.message })
    },
  })

  const createMut = useMutation({
    mutationFn: createScript,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['scripts'] })
      setShowNewForm(false)
      setNewName('')
      setSelectedId(data.id)
    },
    onError: (err) => {
      setSaveMsg({ type: 'error', text: err.response?.data?.detail || err.message })
    },
  })

  const deleteMut = useMutation({
    mutationFn: deleteScript,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scripts'] })
      setSelectedId(null)
      setDraftName('')
      setDraftDesc('')
      setDraftCode('')
    },
  })

  const validateMut = useMutation({
    mutationFn: () => validateScript(selectedId),
    onSuccess: (result) => setValidationResult(result),
    onError: (err) => {
      setValidationResult({ valid: false, error: err.response?.data?.detail || err.message })
    },
  })

  const handleCodeChange = (e) => {
    setDraftCode(e.target.value)
    setIsDirty(true)
    setValidationResult(null)
    setSaveMsg(null)
  }

  const handleSave = () => {
    if (!selectedId) return
    setSaveMsg(null)
    saveMut.mutate({
      id: selectedId,
      payload: { name: draftName, description: draftDesc, script_code: draftCode },
    })
  }

  const handleCreateNew = () => {
    if (!newName.trim()) return
    createMut.mutate({
      name: newName.trim(),
      description: '',
      script_code: templateData?.template ?? '',
    })
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Custom Scripts</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Write Python scripts that define automated trading conditions
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-6 items-start">
        {/* ─── Script list ─────────────────────────────────────────────────── */}
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
              Saved Scripts
            </h2>
            <button
              className="btn-primary !px-2 !py-1 text-xs"
              onClick={() => setShowNewForm(v => !v)}
            >
              <PlusIcon className="h-3.5 w-3.5" />
              New
            </button>
          </div>

          {showNewForm && (
            <div className="flex flex-col gap-2">
              <input
                className="input text-sm"
                placeholder="Script name…"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateNew()}
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  className="btn-primary text-xs flex-1 justify-center"
                  onClick={handleCreateNew}
                  disabled={!newName.trim() || createMut.isPending}
                >
                  {createMut.isPending ? 'Creating…' : 'Create'}
                </button>
                <button
                  className="btn-secondary text-xs"
                  onClick={() => { setShowNewForm(false); setNewName('') }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {scriptsLoading && (
            <div className="space-y-1">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-9 bg-dark-700 rounded-lg animate-pulse" />
              ))}
            </div>
          )}

          {!scriptsLoading && scripts.length === 0 && !showNewForm && (
            <div className="text-sm text-slate-500 py-4 text-center">
              No scripts yet. Create one to get started.
            </div>
          )}

          <ul className="space-y-1">
            {scripts.map(s => (
              <li key={s.id}>
                <button
                  className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                    selectedId === s.id
                      ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-600/30'
                      : 'text-slate-300 hover:bg-dark-700'
                  }`}
                  onClick={() => setSelectedId(s.id)}
                >
                  <DocumentTextIcon className="h-4 w-4 flex-shrink-0 opacity-60" />
                  <span className="truncate">{s.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* ─── Editor area ──────────────────────────────────────────────────── */}
        {selectedScript ? (
          <div className="xl:col-span-2 space-y-4">
            <div className="card space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
                  Editor
                </h2>
                <div className="flex gap-2">
                  <button
                    className="btn-secondary text-xs"
                    onClick={() => validateMut.mutate()}
                    disabled={validateMut.isPending || isDirty}
                    title={isDirty ? 'Save before validating' : 'Validate saved script'}
                  >
                    <CheckCircleIcon className="h-4 w-4" />
                    {validateMut.isPending ? 'Checking…' : 'Validate'}
                  </button>
                  <button
                    className="btn-primary text-xs"
                    onClick={handleSave}
                    disabled={saveMut.isPending || !isDirty}
                  >
                    {saveMut.isPending ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    className="btn-danger text-xs !px-2"
                    onClick={() => {
                      if (window.confirm(`Delete script "${selectedScript.name}"?`)) {
                        deleteMut.mutate(selectedId)
                      }
                    }}
                    disabled={deleteMut.isPending}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Name & description */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Name</label>
                  <input
                    className="input text-sm"
                    value={draftName}
                    onChange={e => { setDraftName(e.target.value); setIsDirty(true) }}
                  />
                </div>
                <div>
                  <label className="label">Description</label>
                  <input
                    className="input text-sm"
                    value={draftDesc}
                    placeholder="Optional description…"
                    onChange={e => { setDraftDesc(e.target.value); setIsDirty(true) }}
                  />
                </div>
              </div>

              {/* Code textarea */}
              <div>
                <label className="label">Script Code</label>
                <textarea
                  className="input font-mono text-xs leading-relaxed w-full resize-y"
                  rows={22}
                  value={draftCode}
                  onChange={handleCodeChange}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </div>

              {/* Status messages */}
              {saveMsg && (
                <div className={`flex items-center gap-2 p-3 rounded-lg text-sm border ${
                  saveMsg.type === 'success'
                    ? 'bg-emerald-900/20 border-emerald-700/30 text-emerald-400'
                    : 'bg-red-900/20 border-red-700/30 text-red-400'
                }`}>
                  {saveMsg.type === 'success'
                    ? <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
                    : <XCircleIcon className="h-4 w-4 flex-shrink-0" />}
                  {saveMsg.text}
                </div>
              )}

              {validationResult && (
                <div className={`flex items-start gap-2 p-3 rounded-lg text-sm border ${
                  validationResult.valid
                    ? 'bg-emerald-900/20 border-emerald-700/30 text-emerald-400'
                    : 'bg-red-900/20 border-red-700/30 text-red-400'
                }`}>
                  {validationResult.valid
                    ? <CheckCircleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    : <XCircleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />}
                  <div>
                    {validationResult.valid ? (
                      <>
                        <div className="font-medium">Script is valid</div>
                        {Object.keys(validationResult.default_params ?? {}).length > 0 && (
                          <div className="text-xs mt-1 text-emerald-500">
                            Default params: {JSON.stringify(validationResult.default_params)}
                          </div>
                        )}
                      </>
                    ) : (
                      <pre className="whitespace-pre-wrap text-xs font-mono">
                        {validationResult.error}
                      </pre>
                    )}
                  </div>
                </div>
              )}

              {isDirty && (
                <div className="text-xs text-amber-400/80">
                  ⚠ Unsaved changes — save before validating.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="xl:col-span-2 card flex items-center justify-center min-h-[300px]">
            <div className="text-center text-slate-500">
              <CodeBracketIcon className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <div className="text-sm">Select a script to edit it</div>
            </div>
          </div>
        )}

        {/* ─── Function reference ───────────────────────────────────────────── */}
        <div className="card">
          <FunctionReference />
        </div>
      </div>
    </div>
  )
}
