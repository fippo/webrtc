/*
 *  Copyright (c) 2015 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* global TimelineDataSeries, TimelineGraphView */

'use strict';

const audio2 = document.querySelector('audio#audio2');
const callButton = document.querySelector('button#callButton');
const hangupButton = document.querySelector('button#hangupButton');
const codecSelector = document.querySelector('select#codec');
hangupButton.disabled = true;
callButton.onclick = call;
hangupButton.onclick = hangup;

let pc1;
let pc2;
let localStream;

let bitrateGraph;
let bitrateSeries;
let headerrateSeries;

let packetGraph;
let packetSeries;

let lastResult;

const offerOptions = {
  offerToReceiveAudio: 1,
  offerToReceiveVideo: 0,
  voiceActivityDetection: false
};

const audioLevels = [];
let audioLevelGraph;
let audioLevelSeries;

// Enabling opus DTX is an expert option without GUI.
// eslint-disable-next-line prefer-const
let useDtx = false;

// Disabling Opus FEC is an expert option without GUI.
// eslint-disable-next-line prefer-const
let useFec = true;

// We only show one way of doing this.
const codecPreferences = document.querySelector('#codecPreferences');
const supportsSetCodecPreferences = window.RTCRtpTransceiver &&
  'setCodecPreferences' in window.RTCRtpTransceiver.prototype;
if (supportsSetCodecPreferences) {
  codecSelector.style.display = 'none';

  const {codecs} = RTCRtpSender.getCapabilities('audio');
  codecs.forEach(codec => {
    if (['audio/CN', 'audio/telephone-event'].includes(codec.mimeType)) {
      return;
    }
    const option = document.createElement('option');
    option.value = (codec.mimeType + ' ' + codec.clockRate + ' ' +
      (codec.sdpFmtpLine || '')).trim();
    option.innerText = option.value;
    codecPreferences.appendChild(option);
  });
  codecPreferences.disabled = false;
} else {
  codecPreferences.style.display = 'none';
}

// Change the ptime. For opus supported values are [10, 20, 40, 60].
// Expert option without GUI.
// eslint-disable-next-line no-unused-vars
async function setPtime(ptime) {
  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  const desc = pc1.remoteDescription;
  if (desc.sdp.indexOf('a=ptime:') !== -1) {
    desc.sdp = desc.sdp.replace(/a=ptime:.*/, 'a=ptime:' + ptime);
  } else {
    desc.sdp += 'a=ptime:' + ptime + '\r\n';
  }
  await pc1.setRemoteDescription(desc);
}

// desired level of redudancy. 4 means "four redundant frames plus current frame.
// It is possible to reduce this to 1 (which is below the native redundancy of 2).
// Note: when changing also realloc frameBuffer.
const targetRedundancy = 2;
let frameBuffer = new Array(targetRedundancy);
function addRedundancy(encodedFrame, controller) {
  if (encodedFrame.data.byteLength < 4) {
    controller.enqueue(encodedFrame);
  }
  /*
   * Attempt to parse the RFC 2198 format. This is harder because
   * past Philipp made the decision to mix opus and red so we
   * need heuristics. Format reminder:
   *     0                   1                    2                   3
    0 1 2 3 4 5 6 7 8 9 0 1 2 3  4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |F|   block PT  |  timestamp offset         |   block length    |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
	   0 1 2 3 4 5 6 7
   +-+-+-+-+-+-+-+-+
   |0|   Block PT  |
   +-+-+-+-+-+-+-+-+
   */
  const opusPayloadType = 111; // we can assume the Block PT is 111
  const view = new DataView(encodedFrame.data);
  const data = new Uint8Array(encodedFrame.data);
  let headerLength = 0;
  let totalLength = 0;
  let redundancy = 0;
  let lengths = [];
  while (headerLength < encodedFrame.data.byteLength) {
    const nextBlock = view.getUint8(headerLength) & 0x80;
    if (!nextBlock) {
      // Parse the last block.
      if ((view.getUint8(headerLength) & 0x7f) !== opusPayloadType) { // Not RED...
        return controller.enqueue(encodedFrame);
      }
      headerLength += 1;
      break;
    }
    redundancy++;
    const blockPayloadType = view.getUint8(headerLength) & 0x7f;
    if (blockPayloadType !== opusPayloadType) { // Not RED.
      return controller.enqueue(encodedFrame);
    }
    const tsOffset = view.getUint16(headerLength + 1) >> 2;
    if (tsOffset % 960 !== 0) { // Not RED.
      return controller.enqueue(encodedFrame);
    }
    const length = view.getUint16(headerLength + 2) & 0x3ff;
    lengths.push(length);
    totalLength += length;
    headerLength += 4;
  }
  if (headerLength + totalLength > encodedFrame.data.byteLength) { // Not RED.
    return controller.enqueue(encodedFrame);
  }
  const frames = [];
  let frameOffset = headerLength;
  while(lengths.length) {
    const length = lengths.shift();
    const frame = data.slice(frameOffset, frameOffset + length);
    frames.push(frame);
    frameOffset += length;
  }
  // frames is mostly used for logging now. TODO: Remove, we only need the current frame.
  const newFrame = data.slice(frameOffset);
  frames.push(newFrame);

  // Now we try to be smart (what can possibly go wrong???).
  // We make some assumptions here for the sake of simplicify such as
  // a timestamp difference of 960.
  const allFrames = frameBuffer.filter(x => !!x).concat(newFrame);
  //console.log('ALL', allFrames.map(f => f[1]));

  const needLength = (allFrames.length - 1) * 4 + 1 + allFrames.reduce((total, frame) => total + frame.byteLength, 0);
  const newData = new Uint8Array(needLength);
  const newView = new DataView(newData.buffer);
  let tOffset = 960 * (allFrames.length - 1);
  // Construct the header.
  frameOffset = 0;
  for (let i = 0; i < allFrames.length - 1; i++) {
    const frame = allFrames[i];
    newView.setUint8(frameOffset, opusPayloadType | 0x80);
    newView.setUint16(frameOffset + 1, (tOffset << 2) ^ (frame.byteLength >> 8));
    newView.setUint8(frameOffset + 3, frame.byteLength & 0xff);
    frameOffset += 4;
    tOffset -= 960;
  }
  // Last block header.
  newView.setUint8(frameOffset++, opusPayloadType);

  // Construct the frame.
  for (let i = 0; i < allFrames.length; i++) {
    const frame = allFrames[i];
    //console.log('SUBFRAME', i, new Uint8Array(frame)[1]);
    newData.set(frame, frameOffset);
    frameOffset += frame.byteLength;
  }
  //console.log('number of frames in the packet', allFrames.length, 'input', frames.length);
  encodedFrame.data = newData.buffer;

  frameBuffer.shift();
  frameBuffer.push(newFrame);

  controller.enqueue(encodedFrame);
}

function gotStream(stream) {
  hangupButton.disabled = false;
  console.log('Received local stream');
  localStream = stream;
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length > 0) {
    console.log(`Using Audio device: ${audioTracks[0].label}`);
  }
  localStream.getTracks().forEach(track => pc1.addTrack(track, localStream));
  pc1.getSenders().forEach(sender => {
    const streams = sender.createEncodedStreams();
    (streams.readable || streams.readableStream).pipeThrough(new TransformStream({
      transform: addRedundancy, 
    }))
    .pipeTo(streams.writableStream);
  });

  if (supportsSetCodecPreferences) {
    const preferredCodec = codecPreferences.options[codecPreferences.selectedIndex];
    if (preferredCodec.value !== '') {
      const [mimeType, clockRate, sdpFmtpLine] = preferredCodec.value.split(' ');
      const {codecs} = RTCRtpSender.getCapabilities('audio');
      console.log(mimeType, clockRate, sdpFmtpLine);
      console.log(JSON.stringify(codecs, null, ' '));
      const selectedCodecIndex = codecs.findIndex(c => c.mimeType === mimeType && c.clockRate === parseInt(clockRate, 10) && c.sdpFmtpLine === sdpFmtpLine);
      const selectedCodec = codecs[selectedCodecIndex];
      codecs.splice(selectedCodecIndex, 1);
      codecs.unshift(selectedCodec);
      const transceiver = pc1.getTransceivers().find(t => t.sender && t.sender.track === localStream.getAudioTracks()[0]);
      transceiver.setCodecPreferences(codecs);
      console.log('Preferred video codec', selectedCodec);
    }
  }

  pc1.createOffer(offerOptions)
      .then(gotDescription1, onCreateSessionDescriptionError);

  bitrateSeries = new TimelineDataSeries();
  bitrateGraph = new TimelineGraphView('bitrateGraph', 'bitrateCanvas');
  bitrateGraph.updateEndDate();

  headerrateSeries = new TimelineDataSeries();
  headerrateSeries.setColor('green');

  packetSeries = new TimelineDataSeries();
  packetGraph = new TimelineGraphView('packetGraph', 'packetCanvas');
  packetGraph.updateEndDate();

  audioLevelSeries = new TimelineDataSeries();
  audioLevelGraph = new TimelineGraphView('audioLevelGraph', 'audioLevelCanvas');
  audioLevelGraph.updateEndDate();
}

function onCreateSessionDescriptionError(error) {
  console.log(`Failed to create session description: ${error.toString()}`);
}

function call() {
  callButton.disabled = true;
  codecSelector.disabled = true;
  console.log('Starting call');
  pc1 = new RTCPeerConnection({encodedInsertableStreams: true});
  console.log('Created local peer connection object pc1');
  pc1.onicecandidate = e => onIceCandidate(pc1, e);
  pc2 = new RTCPeerConnection();
  console.log('Created remote peer connection object pc2');
  pc2.onicecandidate = e => onIceCandidate(pc2, e);
  pc2.ontrack = gotRemoteStream;
  console.log('Requesting local stream');
  navigator.mediaDevices
      .getUserMedia({
        audio: {channelCount: 1},
        video: false
      })
      .then(gotStream, e => {
        alert(`getUserMedia() error: ${e.name}`);
      });
}

function gotDescription1(desc) {
  console.log(`Offer from pc1\n${desc.sdp}`);
  pc1.setLocalDescription(desc)
      .then(() => {
        if (!supportsSetCodecPreferences) {
          desc.sdp = forceChosenAudioCodec(desc.sdp);
        }
        pc2.setRemoteDescription(desc).then(() => {
          return pc2.createAnswer().then(gotDescription2, onCreateSessionDescriptionError);
        }, onSetSessionDescriptionError);
      }, onSetSessionDescriptionError);
}

function gotDescription2(desc) {
  console.log(`Answer from pc2\n${desc.sdp}`);
  pc2.setLocalDescription(desc).then(() => {
    if (!supportsSetCodecPreferences) {
      desc.sdp = forceChosenAudioCodec(desc.sdp);
    }
    if (useDtx) {
      desc.sdp = desc.sdp.replace('useinbandfec=1', 'useinbandfec=1;usedtx=1');
    }
    if (!useFec) {
      desc.sdp = desc.sdp.replace('useinbandfec=1', 'useinbandfec=0');
    }
    pc1.setRemoteDescription(desc).then(() => {}, onSetSessionDescriptionError);
  }, onSetSessionDescriptionError);
}

function hangup() {
  console.log('Ending call');
  localStream.getTracks().forEach(track => track.stop());
  pc1.close();
  pc2.close();
  pc1 = null;
  pc2 = null;
  hangupButton.disabled = true;
  callButton.disabled = false;
  codecSelector.disabled = false;
}

function gotRemoteStream(e) {
  if (audio2.srcObject !== e.streams[0]) {
    audio2.srcObject = e.streams[0];
    console.log('Received remote stream');
  }
}

function getOtherPc(pc) {
  return (pc === pc1) ? pc2 : pc1;
}

function getName(pc) {
  return (pc === pc1) ? 'pc1' : 'pc2';
}

function onIceCandidate(pc, event) {
  getOtherPc(pc).addIceCandidate(event.candidate)
      .then(
          () => onAddIceCandidateSuccess(pc),
          err => onAddIceCandidateError(pc, err)
      );
  console.log(`${getName(pc)} ICE candidate:\n${event.candidate ? event.candidate.candidate : '(null)'}`);
}

function onAddIceCandidateSuccess() {
  console.log('AddIceCandidate success.');
}

function onAddIceCandidateError(error) {
  console.log(`Failed to add ICE Candidate: ${error.toString()}`);
}

function onSetSessionDescriptionError(error) {
  console.log(`Failed to set session description: ${error.toString()}`);
}

function forceChosenAudioCodec(sdp) {
  return maybePreferCodec(sdp, 'audio', 'send', codecSelector.value);
}

// Copied from AppRTC's sdputils.js:

// Sets |codec| as the default |type| codec if it's present.
// The format of |codec| is 'NAME/RATE', e.g. 'opus/48000'.
function maybePreferCodec(sdp, type, dir, codec) {
  const str = `${type} ${dir} codec`;
  if (codec === '') {
    console.log(`No preference on ${str}.`);
    return sdp;
  }

  console.log(`Prefer ${str}: ${codec}`);

  const sdpLines = sdp.split('\r\n');

  // Search for m line.
  const mLineIndex = findLine(sdpLines, 'm=', type);
  if (mLineIndex === null) {
    return sdp;
  }

  // If the codec is available, set it as the default in m line.
  const codecIndex = findLine(sdpLines, 'a=rtpmap', codec);
  console.log('codecIndex', codecIndex);
  if (codecIndex) {
    const payload = getCodecPayloadType(sdpLines[codecIndex]);
    if (payload) {
      sdpLines[mLineIndex] = setDefaultCodec(sdpLines[mLineIndex], payload);
    }
  }

  sdp = sdpLines.join('\r\n');
  return sdp;
}

// Find the line in sdpLines that starts with |prefix|, and, if specified,
// contains |substr| (case-insensitive search).
function findLine(sdpLines, prefix, substr) {
  return findLineInRange(sdpLines, 0, -1, prefix, substr);
}

// Find the line in sdpLines[startLine...endLine - 1] that starts with |prefix|
// and, if specified, contains |substr| (case-insensitive search).
function findLineInRange(sdpLines, startLine, endLine, prefix, substr) {
  const realEndLine = endLine !== -1 ? endLine : sdpLines.length;
  for (let i = startLine; i < realEndLine; ++i) {
    if (sdpLines[i].indexOf(prefix) === 0) {
      if (!substr ||
        sdpLines[i].toLowerCase().indexOf(substr.toLowerCase()) !== -1) {
        return i;
      }
    }
  }
  return null;
}

// Gets the codec payload type from an a=rtpmap:X line.
function getCodecPayloadType(sdpLine) {
  const pattern = new RegExp('a=rtpmap:(\\d+) \\w+\\/\\d+');
  const result = sdpLine.match(pattern);
  return (result && result.length === 2) ? result[1] : null;
}

// Returns a new m= line with the specified codec as the first one.
function setDefaultCodec(mLine, payload) {
  const elements = mLine.split(' ');

  // Just copy the first three parameters; codec order starts on fourth.
  const newLine = elements.slice(0, 3);

  // Put target payload first and copy in the rest.
  newLine.push(payload);
  for (let i = 3; i < elements.length; i++) {
    if (elements[i] !== payload) {
      newLine.push(elements[i]);
    }
  }
  return newLine.join(' ');
}

// query getStats every second
window.setInterval(() => {
  if (!pc1) {
    return;
  }
  const sender = pc1.getSenders()[0];
  sender.getStats().then(res => {
    res.forEach(report => {
      let bytes;
      let headerBytes;
      let packets;
      if (report.type === 'outbound-rtp') {
        if (report.isRemote) {
          return;
        }
        const now = report.timestamp;
        bytes = report.bytesSent;
        headerBytes = report.headerBytesSent;

        packets = report.packetsSent;
        if (lastResult && lastResult.has(report.id)) {
          const deltaT = now - lastResult.get(report.id).timestamp;
          // calculate bitrate
          const bitrate = 8 * (bytes - lastResult.get(report.id).bytesSent) /
            deltaT;
          const headerrate = 8 * (headerBytes - lastResult.get(report.id).headerBytesSent) /
            deltaT;

          // append to chart
          bitrateSeries.addPoint(now, bitrate);
          headerrateSeries.addPoint(now, headerrate);
          bitrateGraph.setDataSeries([bitrateSeries, headerrateSeries]);
          bitrateGraph.updateEndDate();

          // calculate number of packets and append to chart
          packetSeries.addPoint(now, 1000 * (packets -
            lastResult.get(report.id).packetsSent) / deltaT);
          packetGraph.setDataSeries([packetSeries]);
          packetGraph.updateEndDate();
        }
      }
    });
    lastResult = res;
  });
}, 1000);

if (window.RTCRtpReceiver && ('getSynchronizationSources' in window.RTCRtpReceiver.prototype)) {
  let lastTime;
  const getAudioLevel = (timestamp) => {
    window.requestAnimationFrame(getAudioLevel);
    if (!pc2) {
      return;
    }
    const receiver = pc2.getReceivers().find(r => r.track.kind === 'audio');
    if (!receiver) {
      return;
    }
    const sources = receiver.getSynchronizationSources();
    sources.forEach(source => {
      audioLevels.push(source.audioLevel);
    });
    if (!lastTime) {
      lastTime = timestamp;
    } else if (timestamp - lastTime > 500 && audioLevels.length > 0) {
      // Update graph every 500ms.
      const maxAudioLevel = Math.max.apply(null, audioLevels);
      audioLevelSeries.addPoint(Date.now(), maxAudioLevel);
      audioLevelGraph.setDataSeries([audioLevelSeries]);
      audioLevelGraph.updateEndDate();
      audioLevels.length = 0;
      lastTime = timestamp;
    }
  };
  window.requestAnimationFrame(getAudioLevel);
}
