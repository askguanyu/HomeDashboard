import { Component, type ReactNode } from 'react';
import { Placeholder } from './Placeholder';

interface State {
  err: Error | null;
}

/** F8: one broken widget must never take down the dashboard. */
export class ErrorBoundary extends Component<{ id: string; children: ReactNode }, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  render() {
    if (this.state.err) {
      return <Placeholder title={`widget "${this.props.id}" 异常`} note={this.state.err.message} />;
    }
    return this.props.children;
  }
}
