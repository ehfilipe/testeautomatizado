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
test('soma números negativos', () => {
  expect(soma(-2, -3)).toBe(-5);
});

test('soma zero com número', () => {
  expect(soma(0, 5)).toBe(5);
});
test('soma números decimais', () => {
  expect(soma(1.5, 2.5)).toBe(4);
});
