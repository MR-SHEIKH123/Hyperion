import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { decideApproval } from '../api/attention';
import { Button } from '../design-system/components/Button/Button';
import { ErrorNotice } from '../components/ErrorNotice/ErrorNotice';
import { AttentionList } from './AttentionList';
import { useAttention } from './useAttention';
import styles from './AttentionCenter.module.css';

import type { AttentionItem } from '../contracts/wire/attention';
import type { ApprovalDecision } from '../api/attention';

/**
 * The Attention Center: one queue across every tool.
 *
 * `/attention` is its own shell route rather than a panel inside a tool, because
 * the thing it answers is not about a tool — "what is waiting on me, anywhere".
 * Putting it in the Chat sidebar would have made it a Chat feature, and the first
 * thing it usually shows is a Code approval.
 *
 * Answering a prompt from here is deliberately partial: **Allow once** and **Deny**
 * are offered inline, and `allow_session` is not. A standing permission is a
 * decision about a rule, and a rule needs the task's context to be read — the
 * screen that shows what the run was doing and which pattern matched. Offering it
 * as an equal third button in a dense queue is how a user grants a session
 * allowance to the wrong task. Everything is still reachable: the row links to the
 * task, where the full three-way decision lives.
 */
export default function AttentionCenter() {
  const query = useAttention();
  const queryClient = useQueryClient();
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: ({ item, decision }: { item: AttentionItem; decision: ApprovalDecision }) => {
      const resolve = item.resolve;
      if (resolve === undefined) throw new Error('This item has no decision endpoint.');
      const approvalId = item.id.startsWith('approval:') ? item.id.slice('approval:'.length) : item.id;
      return decideApproval(resolve.path, { approvalId, decision });
    },
    onMutate: ({ item }) => {
      setDecidingId(item.id);
      setNotice(null);
    },
    onSuccess: (result, { item, decision }) => {
      // `applied: false` is an answer, not a failure: the server is saying this
      // decision changed nothing. It happens for two reasons that mean different
      // things to the user, and the banner used to ignore the flag entirely and
      // announce an allowance that had not been granted — which is the worst
      // possible wording for a *timed-out* prompt, because it tells the user to
      // expect a call that will never be authorised.
      if (!result.applied) {
        setNotice(
          result.state === 'expired'
            ? `“${item.title}” expired before it was answered, so ${decision === 'deny' ? 'nothing was denied' : 'nothing was allowed'}. Open the task and continue it to be asked again.`
            : `“${item.title}” had already been answered (${result.state}), so this decision changed nothing.`,
        );
        void queryClient.invalidateQueries({ queryKey: ['attention'] });
        return;
      }
      setNotice(
        decision === 'deny'
          ? `Denied “${item.title}”. The run has been finalised.`
          : `Allowed “${item.title}”. ${
              // Answering is not resuming, and this sentence is the one place the
              // difference is explained to a user: the decision is recorded, and the
              // run is started by the task surface's own control
              // (`src/tools/code/ParkedTask.tsx`). Until that panel existed this
              // sentence pointed at a screen that had no such button.
              result.continuable ? 'The task is waiting to continue — open it and press “Continue this task”.' : 'Nothing else is required.'
            }`,
      );
      // The item is gone from the server's answer now; refetching is what makes the
      // row disappear rather than being optimistically removed and possibly wrong.
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
    onSettled: () => { setDecidingId(null); },
  });

  if (query.isPending) {
    return (
      <section className="app-loading" role="status">
        Loading what is waiting on you…
      </section>
    );
  }

  if (query.isError) {
    // The queue is one read; a failure of it is reported as a section failure
    // rather than as an empty queue, which is the state that must never be faked.
    return (
      <div className="app-loading">
        <ErrorNotice onRetry={() => void query.refetch()} />
      </div>
    );
  }

  return (
    <AttentionList
      queue={query.data}
      now={Date.now()}
      onDecide={(item, decision) => { decide.mutate({ item, decision }); }}
      decidingId={decidingId}
      banner={
        <>
          {notice === null ? null : <p role="status" className={styles.notice}>{notice}</p>}
          {decide.isError ? (
            <p className={styles.decisionError} role="alert">
              {decide.error instanceof Error
                ? decide.error.message
                : 'That decision could not be applied.'}{' '}
              <Button variant="quiet" onClick={() => { decide.reset(); }}>
                Dismiss
              </Button>
            </p>
          ) : null}
        </>
      }
    />
  );
}
