// A knowledge tool reads English and Russian: a message in another language is asked as its English
// restatement before the model runs (data agent 0.1.12 contract; a German mail matched a wrong fact at 1.0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryLanguage } from "../workers/agents/language";

test("English and Russian are asked as written; other languages and scripts are not", () => {
  assert.equal(queryLanguage("Premium not active\nHi, I bought Premium but it is not active on my account."), "en");
  assert.equal(queryLanguage("Не работает Premium\nЗдравствуйте, я купил Premium, но он не активен."), "ru");
  assert.equal(queryLanguage("AW: Premium\nHallo, ich habe Premium gekauft aber es ist nicht aktiv."), "other");
  assert.equal(queryLanguage("Premium\nHola, compré Premium pero no está activo en mi cuenta."), "other");
  assert.equal(queryLanguage("Преміум\nДобрий день, я купив Преміум, але він не працює."), "other", "Ukrainian");
  assert.equal(queryLanguage("プレミアムが有効になりません"), "other");
  assert.equal(queryLanguage("Premium"), "en", "too short to tell: asked as written");
});
