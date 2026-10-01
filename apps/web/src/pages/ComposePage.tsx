import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, readableError } from '../api/client.js';
import { resolveSubmissionAttempt, type SubmissionAttempt } from '../lib/idempotency.js';
import { parseLeadFile, type ParsedLeadFile } from '../lib/leads.js';
import { toLocalDateTimeInput, tomorrowAt } from '../lib/time.js';

const initialStart = () => toLocalDateTimeInput(new Date(Date.now() + 5 * 60_000));

export function ComposePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const senders = useQuery({ queryKey: ['senders'], queryFn: api.senders });
  const [senderId, setSenderId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [leadFile, setLeadFile] = useState<ParsedLeadFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [startAt, setStartAt] = useState(initialStart);
  const [delaySeconds, setDelaySeconds] = useState('2');
  const [hourlyLimit, setHourlyLimit] = useState('200');
  const [showSchedule, setShowSchedule] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<SubmissionAttempt | null>(null);

  const availableSenders = senders.data?.items ?? [];
  const effectiveSenderId = senderId || availableSenders[0]?.id || '';
  const mutation = useMutation({
    mutationFn: ({ form, key }: { form: FormData; key: string }) => api.schedule(form, key),
  });
  const signature = useMemo(
    () =>
      JSON.stringify({
        senderId: effectiveSenderId,
        subject: subject.trim(),
        body: body.trim(),
        startAt,
        delaySeconds,
        hourlyLimit,
        recipients: leadFile?.recipients ?? [],
      }),
    [effectiveSenderId, subject, body, startAt, delaySeconds, hourlyLimit, leadFile],
  );

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    setFileError(null);
    try {
      setLeadFile(await parseLeadFile(file));
    } catch (error) {
      setLeadFile(null);
      setFileError(readableError(error instanceof Error ? error : new Error('Invalid file')));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setValidationError(null);
    const delayMs = Number(delaySeconds) * 1_000;
    const limit = Number(hourlyLimit);
    const startDate = new Date(startAt);
    const error = !effectiveSenderId
      ? 'Select a sender.'
      : !leadFile
        ? 'Upload a CSV or TXT recipient list.'
        : !subject.trim()
          ? 'Subject is required.'
          : !body.trim()
            ? 'Body is required.'
            : Number.isNaN(startDate.getTime())
              ? 'Choose a valid start time.'
              : !Number.isInteger(delayMs) || delayMs < 0
                ? 'Delay must be a non-negative number of seconds.'
                : !Number.isInteger(limit) || limit <= 0
                  ? 'Hourly limit must be a positive integer.'
                  : null;
    if (error) {
      setValidationError(error);
      return;
    }
    if (!leadFile) return;

    const nextAttempt = resolveSubmissionAttempt(attempt, signature);
    setAttempt(nextAttempt);
    const form = new FormData();
    form.set('senderId', effectiveSenderId);
    form.set('subject', subject.trim());
    form.set('body', body.trim());
    form.set('startAt', startDate.toISOString());
    form.set('delayMs', String(delayMs));
    form.set('hourlyLimit', String(limit));
    form.set('file', leadFile.file);
    try {
      const result = await mutation.mutateAsync({ form, key: nextAttempt.key });
      setAttempt(null);
      await queryClient.invalidateQueries({ queryKey: ['emails'] });
      await navigate(`/?tab=scheduled&scheduled=${result.totalRecipients}`);
    } catch {
      // Mutation state renders the API error. The attempt remains for a safe retry.
    }
  }

  return (
    <main className="compose-page">
      <header className="compose-header">
        <Link aria-label="Back to dashboard" to="/">
          ←
        </Link>
        <h1>Compose New Email</h1>
        <button
          className="button-primary"
          disabled={mutation.isPending || availableSenders.length === 0}
          form="compose-form"
          type="submit"
        >
          {mutation.isPending ? 'Scheduling…' : 'Schedule'}
        </button>
      </header>
      <form className="compose-form" id="compose-form" onSubmit={(event) => void submit(event)}>
        <div className="form-row">
          <label htmlFor="sender">From</label>
          <select
            id="sender"
            onChange={(event) => setSenderId(event.target.value)}
            value={effectiveSenderId}
          >
            {availableSenders.map((sender) => (
              <option key={sender.id} value={sender.id}>
                {sender.fromName} &lt;{sender.fromEmail}&gt;
              </option>
            ))}
          </select>
        </div>
        {senders.isPending ? (
          <p className="form-help">Loading senders…</p>
        ) : availableSenders.length === 0 ? (
          <div className="form-alert">
            No active sender is available. Ask the administrator to configure an Ethereal-backed
            sender.
          </div>
        ) : null}
        <div className="form-row items-start">
          <label>To</label>
          <div className="min-w-0 flex-1">
            <div className="recipient-line">
              {leadFile ? (
                <>
                  {leadFile.recipients.slice(0, 3).map((email) => (
                    <span className="recipient-chip" key={email}>
                      {email}
                    </span>
                  ))}
                  {leadFile.recipients.length > 3 ? (
                    <span className="recipient-chip">+{leadFile.recipients.length - 3}</span>
                  ) : null}
                </>
              ) : (
                <span className="text-sm text-slate-400">Upload a CSV or TXT lead list</span>
              )}
              <label className="upload-link">
                ⇧ Upload List
                <input
                  accept=".csv,.txt,text/csv,text/plain"
                  className="sr-only"
                  onChange={(event) => void chooseFile(event.target.files?.[0])}
                  type="file"
                />
              </label>
            </div>
            {leadFile ? (
              <p className="form-help">
                {leadFile.recipients.length} unique valid recipients · {leadFile.file.name}
              </p>
            ) : null}
            {fileError ? <p className="form-error">{fileError}</p> : null}
          </div>
        </div>
        <div className="form-row">
          <label htmlFor="subject">Subject</label>
          <input
            id="subject"
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Subject"
            value={subject}
          />
        </div>
        <div className="form-row compact-row">
          <label htmlFor="delay">Delay</label>
          <div className="inline-field">
            <input
              id="delay"
              min="0"
              onChange={(event) => setDelaySeconds(event.target.value)}
              step="1"
              type="number"
              value={delaySeconds}
            />
            <span>seconds between emails</span>
          </div>
          <label htmlFor="limit">Hourly limit</label>
          <input
            className="w-24"
            id="limit"
            min="1"
            onChange={(event) => setHourlyLimit(event.target.value)}
            step="1"
            type="number"
            value={hourlyLimit}
          />
        </div>
        <div className="relative mt-5 flex justify-end">
          <button
            className="button-secondary"
            onClick={() => setShowSchedule((shown) => !shown)}
            type="button"
          >
            ◷ Send Later
          </button>
          {showSchedule ? (
            <div className="schedule-popover">
              <h2>Send Later</h2>
              <label htmlFor="start">Pick date &amp; time</label>
              <input
                id="start"
                min={toLocalDateTimeInput(new Date())}
                onChange={(event) => setStartAt(event.target.value)}
                type="datetime-local"
                value={startAt}
              />
              <div className="mt-3 grid gap-1">
                {[9, 11, 15].map((hour) => (
                  <button
                    key={hour}
                    onClick={() => setStartAt(toLocalDateTimeInput(tomorrowAt(hour)))}
                    type="button"
                  >
                    Tomorrow,{' '}
                    {new Intl.DateTimeFormat(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                    }).format(tomorrowAt(hour))}
                  </button>
                ))}
              </div>
              <button
                className="button-primary mt-4 w-full"
                onClick={() => setShowSchedule(false)}
                type="button"
              >
                Done
              </button>
            </div>
          ) : null}
        </div>
        <label className="mt-5 block text-xs font-medium text-slate-500" htmlFor="body">
          Message
        </label>
        <textarea
          className="message-editor"
          id="body"
          onChange={(event) => setBody(event.target.value)}
          placeholder="Type your message…"
          value={body}
        />
        {validationError ? (
          <p className="form-error mt-4" role="alert">
            {validationError}
          </p>
        ) : null}
        {mutation.isError ? (
          <div className="form-alert mt-4" role="alert">
            <p>{readableError(mutation.error)}</p>
            <p className="mt-1 text-xs">
              Retrying without changing the form safely reuses the same request key.
            </p>
          </div>
        ) : null}
      </form>
    </main>
  );
}
