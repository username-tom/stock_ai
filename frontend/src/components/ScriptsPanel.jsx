import { useScriptsPanel } from './scripts/useScriptsPanel'
import ScriptList from './scripts/ScriptList'
import ScriptEditor from './scripts/ScriptEditor'
import FunctionReference from './scripts/FunctionReference'
import ScriptChatbot from './scripts/ScriptChatbot'

export default function ScriptsPanel() {
  const {
    scripts,
    scriptsLoading,
    builtinTemplates,
    storageInfo,
    selectedId,
    selectedScript,
    selectedTemplate,
    draftName,
    draftDesc,
    draftCode,
    isDirty,
    validationResult,
    saveMsg,
    showNewForm,
    newName,
    createError,
    savePending,
    createPending,
    deletePending,
    validatePending,
    setSelectedId,
    setSelectedTemplate,
    setShowNewForm,
    setNewName,
    setCreateError,
    handleCodeChange,
    handleNameChange,
    handleDescChange,
    handleSave,
    handleCreateNew,
    handleDelete,
    handleValidate,
  } = useScriptsPanel()

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Custom Scripts</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Write Python scripts that define automated trading conditions
          </p>
          {storageInfo?.scripts_dir && (
            <p className="text-xs text-slate-500 mt-1 font-mono">
              Saved to: {storageInfo.scripts_dir}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
        <ScriptList
          scripts={scripts}
          scriptsLoading={scriptsLoading}
          builtinTemplates={builtinTemplates}
          selectedId={selectedId}
          selectedTemplate={selectedTemplate}
          showNewForm={showNewForm}
          newName={newName}
          createError={createError}
          createPending={createPending}
          onSelectScript={setSelectedId}
          onSelectTemplate={setSelectedTemplate}
          onToggleNewForm={() => setShowNewForm(v => !v)}
          onNewNameChange={setNewName}
          onCreateNew={handleCreateNew}
          onCancelNew={() => { setShowNewForm(false); setNewName(''); setCreateError(null) }}
        />

        <ScriptEditor
          selectedScript={selectedScript}
          selectedTemplate={selectedTemplate}
          draftName={draftName}
          draftDesc={draftDesc}
          draftCode={draftCode}
          isDirty={isDirty}
          saveMsg={saveMsg}
          validationResult={validationResult}
          savePending={savePending}
          validatePending={validatePending}
          deletePending={deletePending}
          onNameChange={handleNameChange}
          onDescChange={handleDescChange}
          onCodeChange={handleCodeChange}
          onSave={handleSave}
          onValidate={handleValidate}
          onDelete={handleDelete}
        />
      </div>

      {/* Function reference (fixed floating tab) */}
      <FunctionReference />

      {/* AI Chatbot – bottom-right, above live ticker */}
      <ScriptChatbot />
    </div>
  )
}
