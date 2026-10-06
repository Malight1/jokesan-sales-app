import React from 'react';
import { render, screen } from '@testing-library/react';
import MiniMarkdown, { parseBlocks } from '../miniMarkdown';

// The real answer Ask ProfixBook gave the demo shop, which showed customers
// literal ** and | pipes before this renderer existed.
const REAL_ANSWER = `**Items below their minimum stock level**

| Product | Unit | Qty on hand | Min level | Shortfall |
|---------|------|------------|----------|-----------|
| Agege Bread (loaf) | loaf | 6 | 10 | 4 |
| Indomie Chicken (carton) | carton | 0 | 6 | 6 |

**What to reorder first**

1. **Indomie Chicken** - out of stock (short 6 cartons).
2. **Agege Bread** - below min (short 4 loaves).`;

describe('MiniMarkdown', () => {
  it('turns a real assistant answer into a table and a numbered list, with no raw markup left', () => {
    const { container } = render(<MiniMarkdown text={REAL_ANSWER} />);
    expect(container.querySelector('table')).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Shortfall' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Indomie Chicken (carton)' })).toBeInTheDocument();
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(container.textContent).not.toMatch(/\*\*|\|/);
  });

  it('renders bold, italic and code inline', () => {
    const { container } = render(<MiniMarkdown text={'Sold **12** units, *mostly* on `credit`'} />);
    expect(container.querySelector('strong')?.textContent).toBe('12');
    expect(container.querySelector('em')?.textContent).toBe('mostly');
    expect(container.querySelector('code')?.textContent).toBe('credit');
  });

  it('groups consecutive bullets into one list', () => {
    expect(parseBlocks('- one\n- two\n* three')).toEqual([{ kind: 'ul', items: ['one', 'two', 'three'] }]);
  });

  it('treats a line of pipes without a separator row as a normal paragraph', () => {
    expect(parseBlocks('a | b | c')[0].kind).toBe('p');
  });

  it('never turns model output into live HTML', () => {
    const { container } = render(<MiniMarkdown text={'<img src=x onerror="alert(1)"> **hi**'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x');
  });
});
