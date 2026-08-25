'use client'

import { useState } from 'react'
import { Send } from 'lucide-react'
import type { RunPayload } from '@/lib/api/run'
import type { QAAnswer } from '@/lib/qa/answer'

type Exchange = {
  question: string
  answer: QAAnswer
  recordId: string | null
  mode: 'template' | 'llm'
}

const EXAMPLES = ['why is INV-2008 unresolved?', "what happened with INV-2124?"]

/**
 * RAG over the audit trail this run already produced — no new backend state,
 * just a grounded question over data the client already has in memory. See
 * lib/qa/answer.ts for why retrieval is closed-world (only ids present in
 * this run can ever be answered about) and why the LLM polish, when present,
 * cannot introduce a fact beyond what the template answer already grounds.
 */
export function SettlementQA({ run }: { run: RunPayload }) {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exchanges, setExchanges] = useState<Exchange[]>([])

  async function ask(q: string) {
    const trimmed = q.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed, run }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Q&A failed')
      setExchanges((prev) => [
        { question: trimmed, answer: data.answer, recordId: data.recordId, mode: data.mode },
        ...prev,
      ])
      setQuestion('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Q&A failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          ask(question)
        }}
        className="flex flex-wrap gap-2"
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about a record, e.g. why didn't INV-2841 settle?"
          className="min-w-[280px] flex-1 rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !question.trim()}
          className="flex items-center gap-2 rounded-md border border-accent bg-accent/10 px-4 py-2 font-mono text-xs text-text-primary transition-all hover:scale-[1.02] active:scale-[0.99] disabled:opacity-50 disabled:hover:scale-100"
        >
          <Send size={14} />
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>

      {exchanges.length === 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => ask(ex)}
              className="rounded-md border border-border px-2 py-1 font-mono text-xs text-text-secondary transition-all hover:border-accent hover:text-text-primary"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {error && <p className="mt-3 font-mono text-xs text-danger">{error}</p>}

      {exchanges.length > 0 && (
        <div className="mt-4 space-y-3">
          {exchanges.map((ex, i) => (
            <div key={i} className="rounded-lg border border-border bg-bg p-3">
              <p className="font-mono text-xs text-text-secondary">{ex.question}</p>
              <p className="mt-1.5 font-mono text-xs leading-relaxed text-text-primary">{ex.answer.headline}</p>
              {ex.answer.points.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {ex.answer.points.map((point, j) => (
                    <li key={j} className="flex gap-2 font-mono text-xs leading-relaxed text-text-secondary">
                      <span className="text-accent">·</span>
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1.5 font-mono text-[10px] text-text-secondary">
                {ex.recordId ? `grounded in ${ex.recordId} · ` : ''}
                {ex.mode === 'llm' ? 'LLM-polished, same facts' : 'template — no LLM key configured'}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
