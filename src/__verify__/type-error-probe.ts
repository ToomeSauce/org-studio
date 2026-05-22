// #1525 verify probe — deliberate type error to confirm CI gate blocks merge.
// SAFE TO REVERT: not imported anywhere, doesn't affect build/runtime.
const n: number = "this is a string, not a number";
export default n;
