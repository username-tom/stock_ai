import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon, CodeBracketIcon, DocumentTextIcon } from '@heroicons/react/24/outline'
import { getStrategies, getScripts, getBuiltinTemplates, createScript } from '../../api/client'
import { CUSTOM_SCRIPT_KEY, STRATEGY_PARAM_UI, TEMPLATE_SCRIPT_KEY } from './sandboxConstants'
import { stratLabel, defaultParams } from './sandboxHelpers'

export default function StrategySelector({
  value, scriptId, templateFilename,
  onStrategyChange, onScriptChange, onTemplateChange,
  stratParams, onParamChange,
  symbol,
}) {
  const qc = useQueryClient()
  const { data: stratData, isLoading: stratLoading } = useQuery({ queryKey: ['strategies'], queryFn: getStrategies })
  const { data: scriptsData, isLoading: scriptsLoading } = useQuery({ queryKey: ['scripts'], queryFn: getScripts })
  const { data: templatesData, isLoading: templatesLoading } = useQuery({ queryKey: ['builtin-templates'], queryFn: getBuiltinTemplates })
  const [editorOpen, setEditorOpen] = useState(false)
  const [scriptText, setScriptText] = useState('')
  const [tmplPreviewOpen, setTmplPreviewOpen] = useState(false)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [saveAsName, setSaveAsName] = useState('')
  const [saveAsErr, setSaveAsErr] = useState('')
  const isCustom = value === CUSTOM_SCRIPT_KEY
  const isTemplate = value === TEMPLATE_SCRIPT_KEY
  const scripts = scriptsData?.scripts ?? []
  const templates = (templatesData?.templates ?? []).filter(t => !t.filename.startsWith('_'))
  const paramFields = (isCustom || isTemplate) ? [] : (STRATEGY_PARAM_UI[value] || [])
  const strategies = stratData?.strategies ?? []
  const selectedStrategy = strategies.find(s => s.type === value)
  const selectedScript = isCustom ? scripts.find(s => s.id === scriptId) : null
  const selectedTemplate = isTemplate ? templates.find(t => t.filename === templateFilename) : null

  const createScriptMut = useMutation({
    mutationFn: createScript,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['scripts'] })
      onScriptChange(data.id)
      setSaveAsOpen(false)
      setSaveAsName('')
      setSaveAsErr('')
    },
    onError: (e) => setSaveAsErr(e.response?.data?.detail || e.message),
  })

  function openSaveAs() {
    const baseName = selectedScript?.name ?? 'Script'
    setSaveAsName(symbol ? `${baseName} - ${symbol}` : baseName)
    setSaveAsErr('')
    setSaveAsOpen(true)
  }

  function handleSaveAs() {
    if (!saveAsName.trim()) { setSaveAsErr('Name is required'); return }
    const code = editorOpen ? scriptText : (selectedScript?.script_code ?? '')
    if (!code.trim()) { setSaveAsErr('No script code to save'); return }
    createScriptMut.mutate({
      name: saveAsName.trim(),
      description: selectedScript?.description ?? '',
      script_code: code,
    })
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="label">Strategy</label>
        {stratLoading
          ? <div className="input animate-pulse bg-dark-700 text-transparent">Loading</div>
          : <select className="input" value={value} onChange={e => onStrategyChange(e.target.value)}>
              {strategies.map(s => <option key={s.type} value={s.type}>{stratLabel(s.type)}</option>)}
              <option value={TEMPLATE_SCRIPT_KEY}>📄 Built-in Template</option>
              <option value={CUSTOM_SCRIPT_KEY}>⚙ Custom Script</option>
            </select>
        }
        {selectedStrategy?.description && (
          <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">{selectedStrategy.description}</p>
        )}
      </div>

      {/* Built-in template selector */}
      {isTemplate && (
        <div className="border border-dark-500 rounded-lg overflow-hidden bg-dark-900/30">
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-indigo-400 uppercase tracking-wider border-b border-dark-600">
            <DocumentTextIcon className="h-3.5 w-3.5" />Built-in Template
          </div>
          <div className="p-3 space-y-2">
            {templatesLoading
              ? <div className="h-8 bg-dark-700 rounded animate-pulse" />
              : templates.length === 0
                ? <div className="text-xs text-amber-400/80">No templates found.</div>
                : <>
                    <select
                      className="input"
                      value={templateFilename ?? ''}
                      onChange={e => { onTemplateChange(e.target.value || null); setTmplPreviewOpen(false) }}
                    >
                      <option value="">— choose a template —</option>
                      {templates.map(t => <option key={t.filename} value={t.filename}>{t.name}</option>)}
                    </select>
                    {selectedTemplate && (
                      <>
                        {selectedTemplate.description && (
                          <p className="text-xs text-slate-500 leading-relaxed">{selectedTemplate.description}</p>
                        )}
                        <button
                          type="button"
                          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors w-full text-left"
                          onClick={() => setTmplPreviewOpen(v => !v)}
                        >
                          <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${tmplPreviewOpen ? 'rotate-180' : ''}`} />
                          {tmplPreviewOpen ? 'Hide' : 'Preview'} template code
                        </button>
                        {tmplPreviewOpen && (
                          <textarea
                            readOnly
                            className="w-full h-64 font-mono text-xs bg-dark-950 border border-dark-500 rounded-lg p-3 text-slate-400 resize-y focus:outline-none cursor-default"
                            value={selectedTemplate.script_code}
                            spellCheck={false}
                          />
                        )}
                      </>
                    )}
                  </>
            }
          </div>
        </div>
      )}

      {/* Saved custom script selector */}
      {isCustom && (
        <div className="border border-dark-500 rounded-lg overflow-hidden bg-dark-900/30">
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-slate-400 uppercase tracking-wider border-b border-dark-600">
            <CodeBracketIcon className="h-3.5 w-3.5" />Custom Script
          </div>
          <div className="p-3 space-y-2">
            {scriptsLoading ? <div className="h-8 bg-dark-700 rounded animate-pulse" />
              : scripts.length === 0 ? <div className="text-xs text-amber-400/80">No scripts saved yet. Create one in the Scripts tab.</div>
              : <>
                  <select className="input" value={scriptId ?? ''} onChange={e => {
                    const id = e.target.value ? parseInt(e.target.value, 10) : null
                    onScriptChange(id)
                    const sc = scripts.find(s => s.id === id)
                    setScriptText(sc?.script_code || '')
                    setEditorOpen(false)
                  }}>
                    <option value="">— choose a script —</option>
                    {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {selectedScript && (
                    <>
                      {selectedScript.description && (
                        <p className="text-xs text-slate-500 leading-relaxed">{selectedScript.description}</p>
                      )}
                      <button
                        type="button"
                        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors w-full text-left"
                        onClick={() => { setEditorOpen(v => !v); if (!editorOpen) setScriptText(selectedScript.script_code || '') }}
                      >
                        <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${editorOpen ? 'rotate-180' : ''}`} />
                        {editorOpen ? 'Hide' : 'View / Edit'} script
                      </button>
                      {editorOpen && (
                        <textarea
                          className="w-full h-64 font-mono text-xs bg-dark-950 border border-dark-500 rounded-lg p-3 text-slate-300 resize-y focus:outline-none focus:ring-1 focus:ring-emerald-600/50"
                          value={scriptText}
                          onChange={e => setScriptText(e.target.value)}
                          spellCheck={false}
                        />
                      )}
                      {/* Save as another script */}
                      {!saveAsOpen ? (
                        <button
                          type="button"
                          className="text-xs text-slate-500 hover:text-emerald-400 transition-colors"
                          onClick={openSaveAs}
                        >
                          + Save as new script…
                        </button>
                      ) : (
                        <div className="space-y-1.5 pt-1 border-t border-dark-600">
                          <div className="text-xs text-slate-400 font-medium">Save as new script</div>
                          <input
                            className="input text-sm py-1.5 w-full"
                            type="text"
                            placeholder="Script name"
                            value={saveAsName}
                            onChange={e => { setSaveAsName(e.target.value); setSaveAsErr('') }}
                            onKeyDown={e => e.key === 'Enter' && handleSaveAs()}
                            autoFocus
                          />
                          {saveAsErr && <div className="text-xs text-red-400">{saveAsErr}</div>}
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className="btn-primary text-xs py-1.5 flex-1 disabled:opacity-50"
                              onClick={handleSaveAs}
                              disabled={createScriptMut.isPending}
                            >
                              {createScriptMut.isPending ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              className="btn-secondary text-xs py-1.5 px-3"
                              onClick={() => { setSaveAsOpen(false); setSaveAsErr('') }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </>
            }
          </div>
        </div>
      )}

      {!isCustom && !isTemplate && paramFields.length > 0 && (
        <div className="border border-dark-500 rounded-lg p-3 space-y-2 bg-dark-900/30">
          <div className="text-xs text-slate-500 uppercase tracking-wider">Strategy Parameters</div>
          {paramFields.map(f => (
            <div key={f.key}>
              <label className="label">{f.label}</label>
              {f.type === 'select'
                ? <select className="input" value={stratParams[f.key] ?? f.default} onChange={e => onParamChange(f.key, e.target.value)}>
                    {f.options.map(o => <option key={o}>{o}</option>)}
                  </select>
                : <input className="input" type="number" step={f.step ?? 1} value={stratParams[f.key] ?? f.default}
                    onChange={e => onParamChange(f.key, f.step ? parseFloat(e.target.value) : parseInt(e.target.value, 10))} />
              }
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
