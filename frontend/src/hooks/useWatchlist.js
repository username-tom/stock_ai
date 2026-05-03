import { useState, useRef } from 'react'
import { getQuote, searchSymbols } from '../api/client'

const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'GOOGL', 'TSLA', 'NVDA', 'SPY']
const STORAGE_KEY = 'dashboard_watchlist'

function loadWatchlist() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return DEFAULT_WATCHLIST
}

function saveWatchlist(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) } catch {}
}

export function useWatchlist() {
  const [watchlist, setWatchlist] = useState(loadWatchlist)
  const [editing, setEditing] = useState(false)
  const [addInput, setAddInput] = useState('')
  const [addError, setAddError] = useState('')
  const [addLoading, setAddLoading] = useState(false)
  const [addSuggestions, setAddSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const addDebounce = useRef(null)
  const dragItem = useRef(null)
  const dragOver = useRef(null)

  const updateWatchlist = (next) => {
    setWatchlist(next)
    saveWatchlist(next)
    window.dispatchEvent(new Event('watchlist-updated'))
  }

  const removeSymbol = (sym) => updateWatchlist(watchlist.filter(s => s !== sym))

  // Direct add without async validation — for known-valid symbols (e.g. from movers list)
  const addSymbol = (sym) => {
    if (!watchlist.includes(sym)) updateWatchlist([...watchlist, sym])
  }

  const toggleSymbol = (sym) => {
    watchlist.includes(sym) ? removeSymbol(sym) : addSymbol(sym)
  }

  const handleAdd = async (sym = addInput.trim().toUpperCase()) => {
    if (!sym) return
    setShowSuggestions(false)
    if (watchlist.includes(sym)) { setAddError('Already in watchlist'); return }
    setAddLoading(true)
    setAddError('')
    try {
      await getQuote(sym)
      updateWatchlist([...watchlist, sym])
      setAddInput('')
      setAddSuggestions([])
    } catch {
      setAddError('Symbol not found')
    } finally {
      setAddLoading(false)
    }
  }

  const handleAddInputChange = (e) => {
    const val = e.target.value.toUpperCase()
    setAddInput(val)
    setAddError('')
    clearTimeout(addDebounce.current)
    if (val.length < 1) { setAddSuggestions([]); setShowSuggestions(false); return }
    addDebounce.current = setTimeout(() => {
      searchSymbols(val, 8).then(results => {
        setAddSuggestions(results)
        setShowSuggestions(results.length > 0)
      }).catch(() => {})
    }, 200)
  }

  const handleAddKey = (e) => {
    if (e.key === 'Enter') handleAdd()
    else if (e.key === 'Escape') setShowSuggestions(false)
  }

  const onDragStart = (index) => { dragItem.current = index }
  const onDragEnter = (index) => { dragOver.current = index }
  const onDragEnd = () => {
    if (dragItem.current === null || dragOver.current === null || dragItem.current === dragOver.current) {
      dragItem.current = null; dragOver.current = null; return
    }
    const next = [...watchlist]
    const [moved] = next.splice(dragItem.current, 1)
    next.splice(dragOver.current, 0, moved)
    dragItem.current = null; dragOver.current = null
    updateWatchlist(next)
  }

  const toggleEditing = () => { setEditing(e => !e); setAddInput(''); setAddError('') }

  return {
    watchlist, updateWatchlist,
    editing, toggleEditing,
    addInput, addError, addLoading, addSuggestions, showSuggestions,
    handleAdd, handleAddInputChange, handleAddKey,
    setShowSuggestions,
    removeSymbol, addSymbol, toggleSymbol,
    onDragStart, onDragEnter, onDragEnd,
  }
}
