import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// react-router-dom v7 ships a "main" field pointing at a file that doesn't
// exist, which Jest 27 follows and fails on — it took the whole suite down
// before the moduleNameMapper in package.json. This keeps that fix honest.
it('resolves react-router-dom under jest', () => {
  render(
    <MemoryRouter initialEntries={['/sales']}>
      <Routes><Route path="/sales" element={<p>Sales page</p>} /></Routes>
    </MemoryRouter>
  );
  expect(screen.getByText('Sales page')).toBeInTheDocument();
});
