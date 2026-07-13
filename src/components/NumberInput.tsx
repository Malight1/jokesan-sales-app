import React, { useEffect, useState } from 'react';

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: number;
  onChange: (n: number) => void;
  allowDecimal?: boolean;
}

// Controlled numeric input that:
//  • strips leading zeros (typing "0" then "150" → 150, not "0150")
//  • shows live thousands separators (1,003,993)
//  • preserves decimals while typing ("1.5", "1.")
//  • shows empty (placeholder) when the value is 0
export default function NumberInput({ value, onChange, allowDecimal = true, ...rest }: Props) {
  const format = (n: number) => (n === 0 ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 6 }));
  const [text, setText] = useState(format(value));

  // Re-sync when the value is changed externally (form reset, BOM autofill,
  // product-price prefill) — but don't clobber what the user is mid-typing.
  useEffect(() => {
    const parsed = parseFloat(text.replace(/,/g, ''));
    if ((isNaN(parsed) ? 0 : parsed) !== value) setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    let raw = e.target.value.replace(/,/g, '');
    raw = allowDecimal ? raw.replace(/[^\d.]/g, '') : raw.replace(/[^\d]/g, '');

    // collapse multiple dots
    const dots = raw.split('.');
    if (dots.length > 2) raw = dots[0] + '.' + dots.slice(1).join('');

    if (raw === '' || raw === '.') { setText(raw); onChange(0); return; }

    const [intPart, decPart] = raw.split('.');
    const intNum = parseInt(intPart || '0', 10);
    const formattedInt = (isNaN(intNum) ? 0 : intNum).toLocaleString('en-US');
    const display = decPart !== undefined ? `${formattedInt}.${decPart}` : formattedInt;

    setText(display);
    const num = parseFloat(raw);
    onChange(isNaN(num) ? 0 : num);
  };

  return <input type="text" inputMode={allowDecimal ? 'decimal' : 'numeric'} value={text} onChange={handle} {...rest} />;
}
