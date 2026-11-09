/**
 * The starter templates: four
 * transactional emails a Foreman copies into a draft, changes to the
 * business's words, and proposes like any template. Each is plain blocks,
 * so the Space's brand kit draws it.
 */

import type { EmailTemplate } from "../../../../packages/contracts/src/emailTemplate.ts";

export type Starter = { describe: string; template: EmailTemplate };

export const STARTERS: Readonly<Record<string, Starter>> = {
  receipt: {
    describe: "A payment came in: thanks, the amount, the invoice and what is still owed. The payment hook fills it in.",
    template: {
      version: 1,
      name: "Payment receipt",
      kind: "transactional",
      subject: "Payment received, thank you",
      preheader: "We received {amount} for invoice {invoice_number}.",
      fields: {
        amount: { describe: "The amount paid, with its currency" },
        invoice_number: { describe: "The invoice it pays" },
        paid_on: { describe: "The day it arrived" },
        balance: { describe: "What is still owed on the invoice", default: "Nothing" },
      },
      blocks: [
        { kind: "header" },
        { kind: "text", heading: "Thank you, {first_name}", body: "We received your payment of {amount}. This email is your receipt." },
        { kind: "details", rows: [{ label: "Invoice", value: "{invoice_number}" }, { label: "Paid on", value: "{paid_on}" }, { label: "Amount", value: "{amount}" }, { label: "Still to pay", value: "{balance}" }] },
        { kind: "footer" },
      ],
    },
  },
  "booking-confirmation": {
    describe: "A booking is confirmed: what, when and where.",
    template: {
      version: 1,
      name: "Booking confirmation",
      kind: "transactional",
      subject: "You're booked, {first_name}",
      preheader: "{what} on {date} at {time}.",
      fields: {
        what: { describe: "What they booked: a class, a session, an appointment" },
        date: { describe: "The day, as a person reads it (Tuesday 4 November)" },
        time: { describe: "The start time" },
        place: { describe: "Where, or how to join", default: "We will send the details before the day" },
      },
      blocks: [
        { kind: "header" },
        { kind: "text", heading: "See you soon, {first_name}", body: "Your booking is confirmed." },
        { kind: "details", rows: [{ label: "Booking", value: "{what}" }, { label: "Date", value: "{date}" }, { label: "Time", value: "{time}" }, { label: "Where", value: "{place}" }] },
        { kind: "text", body: "Need to change it? Reply to this email and we will sort it out." },
        { kind: "footer" },
      ],
    },
  },
  invoice: {
    describe: "An invoice is due: its number, the amount, the due date and how to pay.",
    template: {
      version: 1,
      name: "Invoice",
      kind: "transactional",
      subject: "Invoice {invoice_number}",
      preheader: "{amount_due} due by {due_date}.",
      fields: {
        invoice_number: { describe: "The invoice's number" },
        amount_due: { describe: "The amount due, with its currency" },
        due_date: { describe: "The day it is due" },
        how_to_pay: { describe: "How to pay, in the business's words", default: "Reply to this email and we will tell you how to pay." },
      },
      blocks: [
        { kind: "header" },
        { kind: "text", heading: "Hello {first_name}", body: "Here is your invoice. Thank you for your business." },
        { kind: "details", rows: [{ label: "Invoice", value: "{invoice_number}" }, { label: "Amount due", value: "{amount_due}" }, { label: "Due by", value: "{due_date}" }] },
        { kind: "text", heading: "How to pay", body: "{how_to_pay}" },
        { kind: "footer" },
      ],
    },
  },
  "form-reply": {
    describe: "Someone sent a form on the website: thanks, and when they will hear back. The form hook fills it in.",
    template: {
      version: 1,
      name: "Form reply",
      kind: "transactional",
      subject: "Thanks for getting in touch, {first_name}",
      preheader: "We have your message.",
      fields: {
        reply_within: { describe: "When they will hear back", default: "one working day" },
        signed: { describe: "Who signs it", default: "The team" },
      },
      blocks: [
        { kind: "header" },
        { kind: "text", heading: "Thanks, {first_name}", body: "We have your message and will reply within {reply_within}." },
        { kind: "signature", name: "{signed}" },
        { kind: "footer" },
      ],
    },
  },
  outreach: {
    describe: "Outreach, each email written for its person: the subject and words come from each Outreach draft (email_batch). Marketing with no topic, so it needs the website for its unsubscribe link.",
    template: {
      version: 1,
      name: "Outreach",
      kind: "marketing",
      subject: "{subject}",
      fields: {
        subject: { describe: "Each draft's own subject" },
        body: { describe: "Each draft's own words" },
      },
      blocks: [{ kind: "header" }, { kind: "text", body: "{body}" }, { kind: "footer" }],
    },
  },
};
