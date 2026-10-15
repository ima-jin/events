export class Refusal extends Error {}

export const refuse = (condition, message) => {
  if (condition) throw new Refusal(message);
};
