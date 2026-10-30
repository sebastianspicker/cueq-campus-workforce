import { describe, expect, it } from 'vitest';
import { BookingCorrectionPayloadSchema, BookingCorrectionSchema } from './booking.js';

const BOOKING_ID = 'c000000000000000000000001';
const ASSIGNMENT_ID = 'c000000000000000000000002';

describe('booking correction schemas', () => {
  it('accepts the stored workflow payload, which carries no reason', () => {
    const stored = {
      bookingId: BOOKING_ID,
      assignmentId: ASSIGNMENT_ID,
      startTime: '2026-10-01T07:30:00.000Z',
    };

    expect(BookingCorrectionPayloadSchema.parse(stored)).toEqual(stored);
    expect(BookingCorrectionSchema.safeParse(stored).success).toBe(false);
  });

  it('applies the same time-range rules to request and stored payload', () => {
    const inverted = {
      bookingId: BOOKING_ID,
      startTime: '2026-10-01T12:00:00.000Z',
      endTime: '2026-10-01T08:00:00.000Z',
    };

    expect(BookingCorrectionPayloadSchema.safeParse(inverted).success).toBe(false);
    expect(
      BookingCorrectionSchema.safeParse({ ...inverted, reason: 'Wrong end time recorded.' })
        .success,
    ).toBe(false);
  });
});
