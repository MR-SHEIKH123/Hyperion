import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import RoutePlaceholder from './RoutePlaceholder';
import { MemoryRouter } from 'react-router-dom';

describe('route placeholder', () => {
  it('derives the current tool without coupling navigation to feature code', () => {
    render(
      <MemoryRouter initialEntries={['/code']}>
        <RoutePlaceholder />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Hyperion Code' })).toBeInTheDocument();
  });
});
