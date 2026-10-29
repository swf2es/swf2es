// The wall clock of swf2es' Tamarin runs, loaded with --import into each
// worker process of swf2es.ts and, inherited, each of its threads. Some Date
// tests check the current time against DST rules of their own, so their
// counts follow the date; here every run reads the same: the clock starts at
// START when the process or thread does, and runs on in real time, so that
// timed waits, sleeps and getTimer, all read through Date.now, still work.
//
// START is outside both the European and the American DST windows those
// tests apply, and far from any switch, so a process that lives a few
// minutes stays on the same side: Thursday 15 January 2026, 12:00 UTC.
const START = Date.UTC(2026, 0, 15, 12);

const now = Date.now;
const offset = START - now();
Date.now = () => now() + offset;
