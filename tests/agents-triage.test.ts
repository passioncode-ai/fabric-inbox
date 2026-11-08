import { test } from "node:test";
import assert from "node:assert/strict";
import { messageTriage, triageShape, TRIAGE_REPLY } from "../workers/agents/triage";

test("finds a greeting with nothing else", () => {
  for (const text of ["Hi there", "Hello!", "Здравствуйте!", "Привет", "hey team", "Добрый день", "Good morning, support"])
    assert.equal(messageTriage("Hello", text), "greeting");
});
test("finds a message with no words", () => {
  for (const text of ["👍", "??", "...", "", "  \n "]) assert.equal(messageTriage("", text), "empty");
});
test("leaves a question, a closing and a greeting with a question to the writer", () => {
  assert.equal(messageTriage("Hi", "Hi! How do I change the language of the app?"), null);
  assert.equal(messageTriage("Re: your answer", "thanks, it works now"), null);
  assert.equal(messageTriage("hello", "hello\n\nI have a problem"), null);
  assert.equal(messageTriage("Terrible", "This is the worst app ever, nothing works!!!"), null);
});
test("reads the subject when the text is empty", () => {
  assert.equal(messageTriage("Error 403 on login", ""), null);
  assert.equal(messageTriage("Re: Hello", "👍"), "greeting");
  assert.equal(messageTriage("Re:", "👍"), "empty");
  assert.equal(messageTriage("Hello", ""), "greeting");
});

test("passes one or two short sentences with one question", () => {
  assert.equal(triageShape("Hi! What happened, and what were you trying to do?", "clarify"), true);
  assert.equal(triageShape("I can only help with questions about the app. What do you need help with?", "decline"), true);
});
test("refuses links, numbers, addresses, long text and several questions", () => {
  assert.equal(triageShape("See https://example.com for help. What happened?", "clarify"), false);
  assert.equal(triageShape("Premium lasts 12 months. What happened?", "clarify"), false);
  assert.equal(triageShape("Write to help@example.com. What happened?", "decline"), false);
  assert.equal(triageShape("What happened? Which phone? Which version?", "clarify"), false);
  assert.equal(triageShape("One. Two. Three. Four. What happened?", "clarify"), false);
  assert.equal(triageShape("x".repeat(501), "decline"), false);
  assert.equal(triageShape("", "decline"), false);
});

test("has English and Russian, with no dash and no link", () => {
  for (const reply of Object.values(TRIAGE_REPLY)) for (const text of [reply.en, reply.ru]) {
    assert.doesNotMatch(text, /\u2014|https?:/);
    assert.equal(triageShape(text, "clarify"), true);
  }
});
