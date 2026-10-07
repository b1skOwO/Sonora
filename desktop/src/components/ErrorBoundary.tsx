import {Component, type ErrorInfo, type ReactNode} from 'react';
import {logError} from '../lib/diagnostics';
import {usePlayerStore} from '../stores/player';
import {ErrorScreen} from './ui/ErrorScreen';

interface Props {
    children: ReactNode;
    /** Full-screen (app root) vs in-shell (inside a route, keeps the chrome). */
    fullscreen?: boolean;
}

interface State {
    error: Error | null;
    stack: string | null;
}

/** Catches render errors anywhere below and shows the custom ErrorScreen instead
 *  of a blank app. Retry clears the error to re-render the subtree. The React
 *  component stack is captured (production errors carry no component names, the
 *  stack still pinpoints the looping subtree) and written to desktop.log. */
export class ErrorBoundary extends Component<Props, State> {
    state: State = {error: null, stack: null};

    static getDerivedStateFromError(error: Error): State {
        return {error, stack: null};
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        const stack = info.componentStack ?? null;
        this.setState({stack});
        try {
            const player = usePlayerStore.getState();
            logError(
                `[ErrorBoundary] ${error.message} @ ${window.location.pathname} | ` +
                    `track=${player.currentTrack?.urn ?? 'none'} ` +
                    `queue=${player.queue.length} idx=${player.queueIndex} ` +
                    `playing=${player.isPlaying} repeat=${player.repeat}` +
                    (stack ? ` | stack:${stack.split('\n').slice(0, 14).join(' <- ')}` : ''),
            );
        } catch {
            /* diagnostics must never throw */
        }
        console.error('[ErrorBoundary]', error, info.componentStack);
    }

    render() {
        if (this.state.error) {
            return (
                <ErrorScreen
                    error={this.state.error}
                    details={this.state.stack}
                    onRetry={this.reset}
                    fullscreen={this.props.fullscreen}
                />
            );
        }
        return this.props.children;
    }

    private reset = () => this.setState({error: null, stack: null});
}
