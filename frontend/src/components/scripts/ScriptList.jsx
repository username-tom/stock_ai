import { DocumentTextIcon, BookOpenIcon, PlusIcon, XCircleIcon } from '@heroicons/react/24/outline'

export default function ScriptList({
  scripts,
  scriptsLoading,
  builtinTemplates,
  selectedId,
  selectedTemplate,
  showNewForm,
  newName,
  createError,
  createPending,
  onSelectScript,
  onSelectTemplate,
  onToggleNewForm,
  onNewNameChange,
  onCreateNew,
  onCancelNew,
}) {
  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
          Saved Scripts
        </h2>
        <button
          className="btn-primary !px-2 !py-1 text-xs"
          onClick={onToggleNewForm}
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
            onChange={e => onNewNameChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onCreateNew()}
            autoFocus
          />
          <div className="flex gap-2">
            <button
              className="btn-primary text-xs flex-1 justify-center"
              onClick={onCreateNew}
              disabled={!newName.trim() || createPending}
            >
              {createPending ? 'Creating…' : 'Create'}
            </button>
            <button
              className="btn-secondary text-xs"
              onClick={onCancelNew}
            >
              Cancel
            </button>
          </div>
          {createError && (
            <div className="flex items-center gap-2 p-2 rounded-lg text-xs border bg-red-900/20 border-red-700/30 text-red-400">
              <XCircleIcon className="h-3.5 w-3.5 flex-shrink-0" />
              {createError}
            </div>
          )}
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
              onClick={() => onSelectScript(s.id)}
            >
              <DocumentTextIcon className="h-4 w-4 flex-shrink-0 opacity-60" />
              <span className="truncate">{s.name}</span>
            </button>
          </li>
        ))}
        {builtinTemplates.map(tmpl => (
          <li key={tmpl.filename}>
            <button
              className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                selectedTemplate?.filename === tmpl.filename
                  ? 'bg-slate-600/20 text-slate-200 border border-slate-500/40'
                  : 'text-slate-400 hover:bg-dark-700'
              }`}
              onClick={() => onSelectTemplate(tmpl)}
            >
              <BookOpenIcon className="h-4 w-4 flex-shrink-0 opacity-70 text-amber-400" />
              <span className="truncate">{tmpl.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
