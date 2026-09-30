import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './App.js';

describe('App', () => {
  it('renders the Phase 0 application shell', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'ReachInbox Scheduler' })).toBeInTheDocument();
    expect(screen.getByText('reachinbox-scheduler')).toBeInTheDocument();
  });
});
