import {
  CheckCircleIcon, XCircleIcon, TrashIcon, LockClosedIcon, CodeBracketIcon,
} from '@heroicons/react/24/outline'

export default function ScriptEditor({
  selectedScript,
  selectedTemplate,
  draftName,
  draftDesc,
  draftCode,
  isDirty,
  saveMsg,
  validationResult,
  savePending,
  validatePending,
  deletePending,
  onNameChange,
  onDescChange,
  onCodeChange,
  onSave,
  onValidate,
  onDelete,
}) {
  if (!selectedScript && !selectedTemplate) {
    return (
      <div className="xl:col-span-2 card flex items-center justify-center min-h-[300px]">
        <div className="text-center text-slate-500">
          <CodeBracketIcon className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <div className="text-sm">Select a script or template to view it</div>
        </div>
      </div>
    )
  }

  return (
    <div className="xl:col-span-2 space-y-4">
      <div className="card space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="space-y-0.5">
            <h2 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
              {selectedTemplate ? (
                <span className="flex items-center gap-1.5">
                  <LockClosedIcon className="h-3.5 w-3.5 text-amber-400" />
                  Template (read-only)
                </span>
              ) : 'Editor'}
            </h2>
            {selectedScript?.file_path && (
              <p className="text-xs text-slate-500 font-mono">
                Local file: {selectedScript.file_path}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            {selectedScript && (
              <>
                <button
                  className="btn-secondary text-xs"
                  onClick={onValidate}
                  disabled={validatePending || isDirty}
                  title={isDirty ? 'Save before validating' : 'Validate saved script'}
                >
                  <CheckCircleIcon className="h-4 w-4" />
                  {validatePending ? 'Checking…' : 'Validate'}
                </button>
                <button
                  className="btn-primary text-xs"
                  onClick={onSave}
                  disabled={savePending || !isDirty}
                >
                  {savePending ? 'Saving…' : 'Save'}
                </button>
                <button
                  className="btn-danger text-xs !px-2"
                  onClick={onDelete}
                  disabled={deletePending}
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Name & description */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input
              className="input text-sm"
              value={draftName}
              onChange={e => onNameChange(e.target.value)}
              readOnly={!!selectedTemplate}
            />
          </div>
          <div>
            <label className="label">Description</label>
            <input
              className="input text-sm"
              value={draftDesc}
              placeholder="Optional description…"
              onChange={e => onDescChange(e.target.value)}
              readOnly={!!selectedTemplate}
            />
          </div>
        </div>

        {/* Code textarea */}
        <div>
          <label className="label">Script Code</label>
          <textarea
            className={`input font-mono text-xs leading-relaxed w-full resize-y ${
              selectedTemplate ? 'opacity-75 cursor-default' : ''
            }`}
            rows={22}
            value={draftCode}
            onChange={selectedTemplate ? undefined : onCodeChange}
            readOnly={!!selectedTemplate}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>

        {/* Status messages */}
        {saveMsg && selectedScript && (
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

        {isDirty && selectedScript && (
          <div className="text-xs text-amber-400/80">
            ⚠ Unsaved changes — save before validating.
          </div>
        )}
      </div>
    </div>
  )
}
