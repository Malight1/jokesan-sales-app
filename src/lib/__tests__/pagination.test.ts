export {}; // isolatedModules: this file uses require(), so mark it a module

// Guards the bug that made every report quietly wrong: PostgREST caps a
// response at ~1000 rows and returns 200, so an unpaged select just silently
// dropped everything past the cap. The data layer must page until exhausted.

const mockCaptured: { from: number; to: number }[] = [];
let mockTotalRows = 0;

// Minimal stand-in for the supabase query builder: records the .range() window
// it was asked for and serves that slice out of a synthetic table.
function mockMakeBuilder() {
  const builder: any = {
    select: () => builder,
    order: () => builder,
    range: (from: number, to: number) => {
      mockCaptured.push({ from, to });
      const serverCap = 1000; // what PostgREST will actually hand back
      const end = Math.min(to, from + serverCap - 1, mockTotalRows - 1);
      const data = [];
      for (let i = from; i <= end; i++) data.push({ id: i });
      return Promise.resolve({ data, error: null });
    },
  };
  return builder;
}

jest.mock('../supabase', () => ({
  supabase: { from: () => mockMakeBuilder(), rpc: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sales } = require('../api');

beforeEach(() => { mockCaptured.length = 0; });

describe('paged reads', () => {
  it('returns every row when the table fits in one page', async () => {
    mockTotalRows = 42;
    const rows = await sales.list();
    expect(rows).toHaveLength(42);
  });

  it('keeps paging past the 1000-row server cap', async () => {
    mockTotalRows = 2500;
    const rows = await sales.list();
    expect(rows).toHaveLength(2500);
    // ids must be complete and in order, not just the right count
    expect(rows[0].id).toBe(0);
    expect(rows[2499].id).toBe(2499);
  });

  it('advances the window by the rows actually returned', async () => {
    mockTotalRows = 2500;
    await sales.list();
    expect(mockCaptured[0].from).toBe(0);
    expect(mockCaptured[1].from).toBe(1000);
    expect(mockCaptured[2].from).toBe(2000);
  });

  it('stops on the first empty page instead of looping forever', async () => {
    mockTotalRows = 2000;
    await sales.list();
    // 2 full pages + 1 empty page that terminates the walk
    expect(mockCaptured).toHaveLength(3);
  });

  it('handles an empty table', async () => {
    mockTotalRows = 0;
    expect(await sales.list()).toHaveLength(0);
  });
});
