import React, { useEffect, useRef, useState } from 'react';
import { Send, Sparkles } from 'lucide-react';
import { assistant as assistantApi, AssistantQuota } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { planFor } from '../lib/features';
import { Loading } from '../components/DataStates';

interface ChatMessage { role: 'user' | 'assistant'; text: string; }

// The model never touches the database — every fact it states comes from
// a tool call the assistant Edge Function makes as THIS user's own login,
// so a role's normal restrictions (what they can see, which branch) apply
// exactly as they would anywhere else in the app (migration 0036, Phase 7b).
export default function Assistant() {
  const { data: quota, loading: quotaLoading, refetch: refetchQuota } = useQuery<AssistantQuota>(() => assistantApi.quota(), []);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, asking]);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || asking) return;
    setMessages(m => [...m, { role: 'user', text: q }]);
    setInput('');
    setAsking(true);
    try {
      const res = await assistantApi.ask(q, history);
      setMessages(m => [...m, { role: 'assistant', text: res.answer ?? "I couldn't find an answer to that." }]);
      setHistory(res.messages ?? []);
      refetchQuota();
    } catch (err: any) {
      setMessages(m => [...m, { role: 'assistant', text: err.message ?? 'Something went wrong — try again.' }]);
    } finally {
      setAsking(false);
    }
  };

  if (quotaLoading) return <Loading label="Loading Ask StockFlow…" />;

  if (quota && !quota.enabled) {
    return (
      <div className="card" style={{ maxWidth: 520, textAlign: 'center', padding: '2.5rem 1.5rem', margin: '2rem auto' }}>
        <Sparkles size={26} color="#2563eb" style={{ marginBottom: '0.5rem' }} />
        <h3 style={{ marginBottom: '0.35rem' }}>Ask StockFlow</h3>
        <p style={{ color: '#64748b', fontSize: '0.875rem' }}>
          Ask plain questions about your own sales, stock, profit and reorder needs — answered from your real
          data, on the {planFor('assistant')} plan and above.
        </p>
      </div>
    );
  }

  const outOfQuestions = (quota?.remaining ?? 1) <= 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 130px)' }}>
      <div className="page-header">
        <div className="page-title">
          <h1>Ask StockFlow</h1>
          <p>{quota ? `${quota.remaining} of ${quota.limit} questions left this month` : ' '}</p>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '0.25rem 0 0.75rem' }}>
        {messages.length === 0 && (
          <div className="card" style={{ color: '#64748b', fontSize: '0.85rem' }}>
            Try asking things like "What's low on stock?", "How's my profit this month compared to last?",
            "What discounts have I given this month?" or "What should I reorder?"
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '80%', padding: '0.6rem 0.9rem', borderRadius: 12,
            background: m.role === 'user' ? '#2563eb' : '#f1f5f9',
            color: m.role === 'user' ? '#fff' : '#1e293b',
            whiteSpace: 'pre-wrap', fontSize: '0.9rem', lineHeight: 1.45,
          }}>
            {m.text}
          </div>
        ))}
        {asking && (
          <div style={{ alignSelf: 'flex-start', color: '#94a3b8', fontSize: '0.85rem', padding: '0.6rem 0.9rem' }}>
            Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={ask} style={{ display: 'flex', gap: '0.5rem', paddingTop: '0.75rem', borderTop: '1px solid #e2e8f0' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={outOfQuestions ? 'No questions left this month' : 'Ask about your sales, stock or profit…'}
          disabled={asking || outOfQuestions}
          style={{ flex: 1 }}
        />
        <button className="btn-primary" type="submit" disabled={asking || outOfQuestions || !input.trim()}>
          <Send size={15} />
        </button>
      </form>
    </div>
  );
}
