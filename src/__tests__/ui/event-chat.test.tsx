// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatTranscript } from '@/components/chat/chat-transcript';
import { EventChat } from '@/components/chat/event-chat';
import { EVENT_ID } from '../support/ui-support';

describe('event chat presentation', () => {
  it('explains the registered-app gap and disables sending', () => {
    render(<EventChat eventId={EVENT_ID} />);
    expect(screen.getByText('Event Chat').tagName).toBe('SUMMARY');
    expect(screen.getByRole('status', { hidden: true }).textContent).toContain('public chat API is pending');
    expect(screen.getByLabelText('Message')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Send message', hidden: true })).toHaveProperty('disabled', true);
  });

  it('renders an empty conversation', () => {
    render(<ChatTranscript state={{ status: 'ready', messages: [] }} />);
    expect(screen.getByRole('status').textContent).toBe('No messages yet.');
  });

  it('renders populated history using policy-resolved names and escaped text', () => {
    render(<ChatTranscript state={{ status: 'ready', messages: [
      { id: 'msg_1', senderLabel: 'Attendee #1', text: 'See you there!' },
      { id: 'msg_2', senderLabel: '@sam', text: '<script>not executable</script>' },
    ] }} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Attendee #1')).toBeDefined();
    expect(screen.getByText('<script>not executable</script>').querySelector('script')).toBeNull();
  });

  it('shows a load error without claiming the conversation is empty', () => {
    render(<ChatTranscript state={{ status: 'error' }} />);
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
    expect(screen.queryByText('No messages yet.')).toBeNull();
  });
});
