interface ControllerView {
  shortcutEnabled?: boolean;
  kind: string;
  label: string;
  sha?: string;
  action?: 'lock' | 'changes' | 'comment' | 'approve';
  reviewId?: string;
}

interface ControllerContext {
  route: string;
  pageUser: string;
}

interface ControllerToken {
  epoch: number;
  number: number;
  started: number;
}

type ControllerRead = 'state' | 'recheck' | 'resetAttempt';
interface ControllerBase {
  epoch: number;
  sequence: number;
  pageState: string;
  view: ControllerView;
}

type ControllerState = ControllerBase &
  (
    | {phase: 'inactive'; context: null}
    | {phase: 'idle'; context: ControllerContext}
    | {
        phase: 'reading';
        context: ControllerContext;
        operation: ControllerToken;
        op: ControllerRead;
      }
    | {
        phase: 'approving';
        context: ControllerContext;
        operation: ControllerToken;
        sha: string;
        action?: 'changes' | 'comment' | 'approve';
        reviewId?: string;
        deferredRefresh: boolean;
      }
  );

type ControllerEvent = {now: number} & (
  | {type: 'observe'; context: ControllerContext | null; pageState: string}
  | {type: 'reset'}
  | {type: 'refresh'; op: ControllerRead; force?: boolean}
  | {type: 'approve'}
  | {type: 'complete'; token: ControllerToken; view: ControllerView}
);

/* exported initialController, transitionController */
function initialController(): ControllerState {
  return {
    phase: 'inactive',
    context: null,
    epoch: 0,
    sequence: 0,
    pageState: '',
    view: {kind: 'loading', label: 'Checking approval…'},
  };
}

/** Pure request-lifecycle machine. Only the active token may replace the accepted view. */
function transitionController(state: ControllerState, event: ControllerEvent): ControllerState {
  function read(
    context: ControllerContext,
    base: ControllerBase = state,
    op: ControllerRead = 'state',
  ): ControllerState {
    const sequence = base.sequence + 1;
    return {
      epoch: base.epoch,
      pageState: base.pageState,
      view: base.view,
      phase: 'reading',
      context,
      sequence,
      op,
      operation: {epoch: base.epoch, number: sequence, started: event.now},
    };
  }

  switch (event.type) {
    case 'reset':
      return {...initialController(), epoch: state.epoch + 1, sequence: state.sequence + 1};
    case 'observe': {
      const changed =
        event.context?.route !== state.context?.route ||
        event.context?.pageUser !== state.context?.pageUser;
      if (changed) {
        const base = {
          ...initialController(),
          epoch: state.epoch + 1,
          sequence: state.sequence + 1,
          pageState: event.pageState,
        };
        return event.context ? read(event.context, base) : base;
      }
      if (!event.pageState || event.pageState === state.pageState || !state.context) return state;
      if (state.phase === 'approving')
        return {...state, pageState: event.pageState, deferredRefresh: true};
      return read(state.context, {...state, pageState: event.pageState});
    }
    case 'refresh':
      if (
        !state.context ||
        state.phase === 'approving' ||
        (state.phase === 'reading' && event.op === 'state' && !event.force)
      )
        return state;
      return read(state.context, state, event.op);
    case 'approve': {
      if (
        (state.phase !== 'idle' && state.phase !== 'reading') ||
        state.view.kind !== 'available' ||
        !state.view.sha ||
        state.view.action === 'lock'
      )
        return state;
      const sequence = state.sequence + 1;
      return {
        epoch: state.epoch,
        sequence,
        pageState: state.pageState,
        view: state.view,
        phase: 'approving',
        context: state.context,
        operation: {epoch: state.epoch, number: sequence, started: event.now},
        sha: state.view.sha,
        ...(state.view.action ? {action: state.view.action} : {}),
        ...(state.view.reviewId ? {reviewId: state.view.reviewId} : {}),
        deferredRefresh: false,
      };
    }
    case 'complete': {
      if (
        (state.phase !== 'reading' && state.phase !== 'approving') ||
        state.operation.epoch !== event.token.epoch ||
        state.operation.number !== event.token.number
      )
        return state;
      const next: ControllerState = {
        phase: 'idle',
        context: state.context,
        epoch: state.epoch,
        sequence: state.sequence,
        pageState: state.pageState,
        view: event.view,
      };
      return state.phase === 'approving' && state.deferredRefresh
        ? read(state.context, next)
        : next;
    }
  }
}
