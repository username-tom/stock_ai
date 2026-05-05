import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getScripts, getScriptTemplate, getBuiltinTemplates, getScriptStorageInfo,
  createScript, updateScript, deleteScript, validateScript,
} from '../../api/client'

export function useScriptsPanel() {
  const qc = useQueryClient()
  const { pathname } = useLocation()

  const [selectedId, setSelectedId] = useState(null)
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [draftName, setDraftName] = useState('')
  const [draftDesc, setDraftDesc] = useState('')
  const [draftCode, setDraftCode] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [validationResult, setValidationResult] = useState(null)
  const [saveMsg, setSaveMsg] = useState(null)
  const [showNewForm, setShowNewForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState(null)

  const { data: scriptsData, isLoading: scriptsLoading } = useQuery({
    queryKey: ['scripts'],
    queryFn: getScripts,
    staleTime: 0,
  })

  const { data: templateData } = useQuery({
    queryKey: ['script-template'],
    queryFn: getScriptTemplate,
  })

  const { data: builtinData } = useQuery({
    queryKey: ['builtin-templates'],
    queryFn: getBuiltinTemplates,
    staleTime: Infinity,
  })

  const { data: storageInfo } = useQuery({
    queryKey: ['script-storage-info'],
    queryFn: getScriptStorageInfo,
    staleTime: Infinity,
  })

  const builtinTemplates = builtinData?.templates ?? []
  const scripts = scriptsData?.scripts ?? []
  const selectedScript = scripts.find(s => s.id === selectedId) ?? null

  // Refetch when the Scripts tab becomes active
  useEffect(() => {
    if (pathname === '/scripts') {
      qc.invalidateQueries({ queryKey: ['scripts'] })
    }
  }, [pathname, qc])

  // Populate editor when a saved script is selected
  useEffect(() => {
    if (selectedScript) {
      setSelectedTemplate(null)
      setDraftName(selectedScript.name)
      setDraftDesc(selectedScript.description ?? '')
      setDraftCode(selectedScript.script_code)
      setIsDirty(false)
      setValidationResult(null)
      setSaveMsg(null)
    }
  }, [selectedScript])

  // Populate read-only editor when a template is selected
  useEffect(() => {
    if (selectedTemplate) {
      setSelectedId(null)
      setDraftName(selectedTemplate.name)
      setDraftDesc(selectedTemplate.description ?? '')
      setDraftCode(selectedTemplate.script_code)
      setIsDirty(false)
      setValidationResult(null)
      setSaveMsg(null)
    }
  }, [selectedTemplate])

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
      setCreateError(null)
      setSelectedId(data.id)
    },
    onError: (err) => {
      setCreateError(err.response?.data?.detail || err.message)
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

  const handleNameChange = (v) => { setDraftName(v); setIsDirty(true) }
  const handleDescChange = (v) => { setDraftDesc(v); setIsDirty(true) }

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

  const handleUseTemplate = (tmpl) => {
    createMut.mutate({
      name: tmpl.name,
      description: tmpl.description,
      script_code: tmpl.script_code,
    })
  }

  const handleDelete = () => {
    if (window.confirm(`Delete script "${selectedScript.name}"?`)) {
      deleteMut.mutate(selectedId)
    }
  }

  return {
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
    savePending: saveMut.isPending,
    createPending: createMut.isPending,
    deletePending: deleteMut.isPending,
    validatePending: validateMut.isPending,
    setSelectedId,
    setSelectedTemplate,
    setDraftName,
    setDraftDesc,
    setShowNewForm,
    setNewName,
    setCreateError,
    handleCodeChange,
    handleNameChange,
    handleDescChange,
    handleSave,
    handleCreateNew,
    handleUseTemplate,
    handleDelete,
    handleValidate: () => validateMut.mutate(),
  }
}
