import React, { useEffect, useState } from 'react';
import { FileText, ImageOff } from 'lucide-react';
import { support, SupportAttachment } from '../lib/api';

// One file on a support message, for either side of the conversation.
// Most of what customers attach is a screenshot of the problem, so an
// image shows inline instead of hiding behind a "click to open" link.
// The bucket is private: every view goes through a short-lived signed URL.
export default function TicketAttachment({ file }: { file: SupportAttachment }) {
  const isImage = (file.content_type ?? '').startsWith('image/');
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    support.attachmentUrl(file.storage_path)
      .then(u => { if (alive) setUrl(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [isImage, file.storage_path]);

  const open = async () => {
    setOpening(true);
    try { window.open(url ?? await support.attachmentUrl(file.storage_path), '_blank', 'noopener'); }
    catch { setFailed(true); }
    finally { setOpening(false); }
  };

  if (isImage && !failed) {
    return (
      <button type="button" className="sp-att-img" onClick={open} title={`Open ${file.file_name} full size`}>
        {url ? <img src={url} alt={file.file_name} loading="lazy" /> : <span className="sp-att-img-loading" aria-hidden="true" />}
        <span className="sp-att-name">{file.file_name}</span>
      </button>
    );
  }

  return (
    <button type="button" className="sp-att" onClick={open} disabled={opening}>
      {failed ? <ImageOff size={13} /> : <FileText size={13} />}
      <span>{opening ? 'Opening…' : failed ? `${file.file_name} (couldn't load)` : file.file_name}</span>
    </button>
  );
}
