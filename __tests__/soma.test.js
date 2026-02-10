const soma = require('../index');

describe('soma', () => {
  test('soma dois números positivos', () => {
    expect(soma(2, 3)).toBe(5);
  });

  test('funciona com números negativos', () => {
    expect(soma(-2, -3)).toBe(-5);
  });

  test('soma positivo com negativo', () => {
    expect(soma(5, -3)).toBe(2);
  });
});
