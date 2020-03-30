/*
 *  Copyright (c) 2020 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */

'use strict';

/* global VideoPipe */

const video1 = document.querySelector('video#video1');
const video2 = document.querySelector('video#video2');
const videoMonitor = document.querySelector('#video-monitor');

const startButton = document.querySelector('button#start');
const callButton = document.querySelector('button#call');
const hangupButton = document.querySelector('button#hangup');

const cryptoKey = document.querySelector('#crypto-key');
const banner = document.querySelector('#banner');

startButton.onclick = start;
callButton.onclick = call;
hangupButton.onclick = hangup;

cryptoKey.addEventListener('change', setCryptoKey);

let startToMiddle;
let startToEnd;
let currentCryptoKey;

let localStream;
// eslint-disable-next-line no-unused-vars
let remoteStream;

const supportsInsertableStreams =
      !!RTCRtpSender.prototype.createEncodedVideoStreams;

if (!supportsInsertableStreams) {
  banner.innerText = 'Your browser does not support Insertable Streams. ' +
  'This sample will not work.';
  cryptoKey.hidden = true;
}

function gotStream(stream) {
  console.log('Received local stream');
  video1.srcObject = stream;
  localStream = stream;
  callButton.disabled = false;
}

function gotremoteStream(stream) {
  console.log('Received remote stream');
  remoteStream = stream;
  video2.srcObject = stream;
}

function start() {
  console.log('Requesting local stream');
  startButton.disabled = true;
  const options = {audio: false, video: true};
  navigator.mediaDevices
      .getUserMedia(options)
      .then(gotStream)
      .catch(function(e) {
        alert('getUserMedia() failed');
        console.log('getUserMedia() error: ', e);
      });
}

function call() {
  callButton.disabled = true;
  hangupButton.disabled = false;
  console.log('Starting call');
  // The real use case is where the middle box relays the
  // packets and listens in, but since we don't have
  // access to raw packets, we just send the same video
  // to both places.
  startToMiddle = new VideoPipe(localStream, encodeFunction, null, stream => {
    videoMonitor.srcObject = stream;
  });
  startToEnd = new VideoPipe(localStream, encodeFunction, decodeFunction,
      gotremoteStream);
  console.log('Video pipes created');
}

function hangup() {
  console.log('Ending call');
  startToMiddle.close();
  startToEnd.close();
  hangupButton.disabled = true;
  callButton.disabled = false;
}

function encodeFunction(chunk, controller) {
  if (currentCryptoKey) {
    const view = new DataView(chunk.data);
    // Any length that is needed can be used for the new buffer.
    const newData = new ArrayBuffer(chunk.data.byteLength + 4);
    const newView = new DataView(newData);

    for (let i = 0; i < chunk.data.byteLength; ++i) {
      const keyByte = currentCryptoKey.charCodeAt(i % currentCryptoKey.length);
      newView.setInt8(i, view.getInt8(i) ^ keyByte);
    }
    // Append checksum
    newView.setUint32(chunk.data.byteLength, 0xDEADBEEF);

    chunk.data = newData;
  }
  controller.enqueue(chunk);
}

function decodeFunction(chunk, controller) {
  if (currentCryptoKey) {
    const view = new DataView(chunk.data);
    const checksum = view.getUint32(chunk.data.byteLength - 4);
    if (checksum != 0xDEADBEEF) {
      console.log('Corrupted frame received');
      console.log(checksum.toString(16));
    }
    const newData = new ArrayBuffer(chunk.data.byteLength - 4);
    const newView = new DataView(newData);
    for (let i = 0; i < chunk.data.byteLength - 4; ++i) {
      const keyByte = currentCryptoKey.charCodeAt(i % currentCryptoKey.length);
      newView.setInt8(i, view.getInt8(i) ^ keyByte);
    }
    chunk.data = newData;
  }
  controller.enqueue(chunk);
}

function setCryptoKey(event) {
  console.log('Setting crypto key to ' + event.target.value);
  currentCryptoKey = event.target.value;
  if (currentCryptoKey) {
    banner.innerText = 'Encryption is ON';
  } else {
    banner.innerText = 'Encryption is OFF';
  }
}
