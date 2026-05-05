import { useState, useRef, useEffect } from 'react'
import {
  ChatBubbleLeftRightIcon,
  PaperAirplaneIcon,
  XMarkIcon,
  ChevronDownIcon,
  SparklesIcon,
  ClipboardDocumentIcon,
  CheckIcon,
} from '@heroicons/react/24/outline'
import { chatWithScriptAI } from '../../api/client'

function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="relative mt-2 rounded-md bg-slate-900 border border-slate-700 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-800 border-b border-slate-700">
        <span className="text-xs text-slate-400 font-mono">python</span>
        <button
          onClick={handleCopy}
          className="text-slate-400 hover:text-slate-200 transition-colors"
          title="Copy code"
        >
          {copied
            ? <CheckIcon className="h-4 w-4 text-emerald-400" />
            : <ClipboardDocumentIcon className="h-4 w-4" />}
        </button>
      </div>
      <pre className="p-3 text-xs text-slate-200 font-mono overflow-x-auto whitespace-pre-wrap break-words">
        {code}
      </pre>
    </div>
  )
}

function MessageContent({ content }) {
  // Split on ```python ... ``` blocks
  const parts = content.split(/(```python[\s\S]*?```|```[\s\S]*?```)/g)
  return (
    <>
      {parts.map((part, i) => {
        const codeMatch = part.match(/^```(?:python)?\n?([\s\S]*?)```$/)
        if (codeMatch) {
          return <CodeBlock key={i} code={codeMatch[1].trimEnd()} />
        }
        if (!part) return null
        return (
          <span key={i} className="whitespace-pre-wrap break-words">
            {part}
          </span>
        )
      })}
    </>
  )
}

export default function ScriptChatbot() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        "Hi! I'm your script assistant powered by Ollama + Gemma. Ask me to write a strategy, explain a template, or modify existing scripts. I have access to all your saved scripts and built-in templates.",
    },
  ])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const abortRef = useRef(null)

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')

    const newMessages = [...messages, { role: 'user', content: text }]
    setMessages(newMessages)
    setStreaming(true)
    setWaiting(true)

    // Add placeholder assistant message
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])

    // Build history excluding the initial greeting for API (keep last 20 turns)
    const history = newMessages.slice(-20).map(m => ({ role: m.role, content: m.content }))

    try {
      const resp = await chatWithScriptAI(history)
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      abortRef.current = reader

      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.error) {
              setWaiting(false)
              setMessages(prev => {
                const updated = [...prev]
                updated[updated.length - 1] = {
                  role: 'assistant',
                  content: `⚠️ ${data.error}`,
                }
                return updated
              })
              break
            }
            if (data.waiting) {
              // backend acknowledged — keep waiting indicator shown
              continue
            }
            if (data.content) {
              setWaiting(false)
              setMessages(prev => {
                const updated = [...prev]
                updated[updated.length - 1] = {
                  role: 'assistant',
                  content: updated[updated.length - 1].content + data.content,
                }
                return updated
              })
            }
          } catch {
            // ignore malformed SSE
          }
        }
      }
    } catch (err) {
      setWaiting(false)
      setMessages(prev => {
        const updated = [...prev]
        updated[updated.length - 1] = {
          role: 'assistant',
          content: `⚠️ ${err.message}`,
        }
        return updated
      })
    } finally {
      setWaiting(false)
      setStreaming(false)
      abortRef.current = null
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleStop = () => {
    abortRef.current?.cancel()
    setWaiting(false)
    setStreaming(false)
  }

  return (
    <div className="fixed bottom-10 right-6 z-50 flex flex-col items-end gap-2">
      {/* Chat window */}
      {open && (
        <div className="flex flex-col w-96 max-h-[560px] rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-slate-800 border-b border-slate-700 shrink-0">
            <div className="flex items-center gap-2">
              <SparklesIcon className="h-4 w-4 text-violet-400" />
              <span className="text-sm font-semibold text-slate-100">Script AI</span>
              <span className="text-xs text-slate-500 font-mono">gemma4 · ollama</span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-slate-400 hover:text-slate-200 transition-colors"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-violet-600 text-white'
                      : 'bg-slate-800 text-slate-200 border border-slate-700'
                  }`}
                >
                  {msg.role === 'assistant'
                    ? <MessageContent content={msg.content || (streaming && i === messages.length - 1 ? '▋' : '')} />
                    : msg.content}
                  {streaming && i === messages.length - 1 && msg.role === 'assistant' && msg.content && (
                    <span className="inline-block w-1 h-3 bg-violet-400 animate-pulse ml-0.5 align-middle" />
                  )}
                </div>
              </div>
            ))}
            {waiting && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-400">
                  <span className="flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                  </span>
                  I'm working on it…
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="flex items-end gap-2 px-3 py-3 border-t border-slate-700 bg-slate-800 shrink-0">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask me to write a strategy…"
              disabled={streaming}
              className="flex-1 resize-none bg-slate-700 text-slate-100 text-xs rounded-lg px-3 py-2 placeholder-slate-500 border border-slate-600 focus:outline-none focus:border-violet-500 disabled:opacity-50 max-h-28 overflow-y-auto"
              style={{ minHeight: '36px' }}
            />
            {streaming ? (
              <button
                onClick={handleStop}
                className="shrink-0 rounded-lg p-2 bg-red-600 hover:bg-red-500 text-white transition-colors"
                title="Stop"
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={sendMessage}
                disabled={!input.trim()}
                className="shrink-0 rounded-lg p-2 bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 transition-colors"
                title="Send"
              >
                <PaperAirplaneIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 rounded-full px-4 py-2.5 bg-violet-600 hover:bg-violet-500 text-white shadow-lg transition-colors"
      >
        {open
          ? <ChevronDownIcon className="h-4 w-4" />
          : <ChatBubbleLeftRightIcon className="h-4 w-4" />}
        <span className="text-sm font-medium">{open ? 'Close' : 'Script AI'}</span>
      </button>
    </div>
  )
}
