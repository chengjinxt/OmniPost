// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './App.js';

describe('App', () => {
  it('presents the creator workspace and launch actions', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: '内容工作台' })).toBeInTheDocument();
    expect(screen.getByText('一次创作，多端抵达')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建内容' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入内容' })).toBeInTheDocument();
    expect(screen.getByText('微信公众号')).toBeInTheDocument();
    expect(screen.getByText('抖音')).toBeInTheDocument();
    expect(screen.getByText('YouTube')).toBeInTheDocument();
    expect(screen.getByText('知乎')).toBeInTheDocument();
  });
});
