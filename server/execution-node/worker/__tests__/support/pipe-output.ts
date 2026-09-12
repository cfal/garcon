console.log('synthetic import log');
console.info('synthetic import info');
console.debug('synthetic import debug');
console.error('synthetic import error');
process.stdout.write('synthetic stdout write\n');
const bytes = new TextEncoder().encode('!synthetic console bytes!');
console.write(bytes.subarray(1, -1), '\n', new TextEncoder().encode('synthetic array buffer\n').buffer);

export {};
