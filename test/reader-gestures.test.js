import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTrackpadPageTurn, readerGestureAllowed } from '../public/js/knowledge/reader-gestures.js';

function setup() {
  let time = 0, allowed = true;
  const turns = [];
  const handle = createTrackpadPageTurn({ canTurn: () => allowed, turn: d => turns.push(d), now: () => time });
  const wheel = (x, y = 0, extra = {}) => { let prevented = false; handle({ deltaX:x, deltaY:y, deltaMode:0, target:{ closest:() => null }, preventDefault:() => { prevented = true; }, ...extra }); return prevented; };
  return { turns, wheel, advance: n => { time += n; }, disable: () => { allowed = false; } };
}

test('trackpad accumulates movement and consumes the inertial tail once', () => {
  const s = setup(); s.wheel(30); s.advance(20); s.wheel(35);
  for (let i = 0; i < 20; i++) { s.advance(25); s.wheel(10); }
  assert.deepEqual(s.turns, ['right']);
  s.advance(250); s.wheel(-65); assert.deepEqual(s.turns, ['right','left']);
});
test('vertical scroll, pinch zoom and unavailable pagination remain native', () => {
  const s = setup(); assert.equal(s.wheel(10,80), false); assert.equal(s.wheel(100,0,{ctrlKey:true}), false);
  s.disable(); assert.equal(s.wheel(100), false); assert.deepEqual(s.turns, []);
});
test('interactive controls and horizontally scrollable content retain their gestures', () => {
  const s = setup(); assert.equal(s.wheel(100,0,{target:{closest:() => ({})}}),false);
  const target = { nodeType:1, closest:() => null, scrollWidth:500, clientWidth:200, scrollLeft:20, parentElement:null, ownerDocument:{defaultView:{getComputedStyle:() => ({overflowX:'auto'})}} };
  assert.equal(s.wheel(100,0,{target}),false); assert.deepEqual(s.turns,[]);
});

test('outer and chapter input focus suppress gestures over the book iframe', () => {
  const dom = new JSDOM('<input id="tags"><div data-book-ready="true"><iframe></iframe></div>');
  try {
    const doc = dom.window.document, host = doc.querySelector('div'), view = doc.querySelector('iframe');
    const chapter = view.contentDocument;
    chapter.body.innerHTML = '<input><p>Book text</p>';
    const event = { target:chapter.querySelector('p') };
    const allowed = () => readerGestureAllowed({host,view,event,paginated:true});
    assert.equal(allowed(),true);
    doc.querySelector('#tags').focus(); assert.equal(allowed(),false);
    doc.querySelector('#tags').blur(); assert.equal(allowed(),true);
    chapter.querySelector('input').focus(); assert.equal(allowed(),false);
    chapter.querySelector('input').blur(); assert.equal(allowed(),true);
  } finally { dom.window.close(); }
});

test('TXT raw mode preserves scrolling and resumes gestures only when the reader is visible', () => {
  const dom = new JSDOM('<div data-book-ready="true"><iframe hidden></iframe><pre>Raw text</pre></div>');
  try {
    const doc = dom.window.document, host = doc.querySelector('div'), view = doc.querySelector('iframe');
    const turns = [];
    const handle = createTrackpadPageTurn({canTurn:event => readerGestureAllowed({host,view,event,paginated:true}),turn:d => turns.push(d)});
    let prevented = false;
    const event = {target:doc.querySelector('pre'),deltaX:100,deltaY:0,deltaMode:0,preventDefault:() => { prevented=true; }};
    handle(event); assert.equal(prevented,false); assert.deepEqual(turns,[]);
    view.hidden=false; handle(event); assert.equal(prevented,true); assert.deepEqual(turns,['right']);
  } finally { dom.window.close(); }
});
