'use strict';

// Generate a private, stable question order for one student attempt.
// Fisher-Yates is unbiased when Math.random() is uniform.
function createQuestionOrder(questionIds, random = Math.random) {
  const ids = questionIds.map(id => String(id));
  for ( (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

function orderQuestions(questions, orderedIds) {
  const byId = new Map(questions.map(question => [String(question._id), question]));
  return orderedIds.map(id => byId.get(String(id))).filter(Boolean);
}

module.exports = { createQuestionOrder, orderQuestions };
