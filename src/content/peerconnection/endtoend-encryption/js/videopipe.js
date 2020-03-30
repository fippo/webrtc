/*
 *  Copyright (c) 2020 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
//
// A "videopipe" abstraction on top of WebRTC.
//
// The usage of this abstraction:
// var pipe = new VideoPipe(mediastream, handlerFunction);
// handlerFunction = function(mediastream) {
//   do_something
// }
// pipe.close();
//
// The VideoPipe will set up 2 PeerConnections, connect them to each
// other, and call HandlerFunction when the stream is available in the
// second PeerConnection.
//
'use strict';

function VideoPipe(stream, sendTransform, receiveTransform, handler) {
  this.pc1 = new RTCPeerConnection({
    forceEncodedVideoInsertableStreams: true
  });
  this.pc2 = new RTCPeerConnection({
    forceEncodedVideoInsertableStreams: true
  });

  stream.getTracks().forEach(track => this.pc2.addTrack(track, stream));
  const sender = this.pc2.getSenders().find(s => s.track && s.track.kind === 'video');
  if (sendTransform) {
    const senderStreams = sender.createEncodedVideoStreams();
    const senderTransformStream = new TransformStream({
      start() {},
      flush() {},
      transform: sendTransform
    });
    senderStreams.readableStream
        .pipeThrough(senderTransformStream)
        .pipeTo(senderStreams.writableStream);
  }
  this.pc1.ontrack = e => {
    if (receiveTransform) {
      const transform = new TransformStream({
        start() {},
        flush() {},
        transform: receiveTransform
      });
      const receiverStreams = e.receiver.createEncodedVideoStreams();
      receiverStreams.readableStream
          .pipeThrough(transform)
          .pipeTo(receiverStreams.writableStream);
    }
    handler(e.streams[0]);
  };

  this.negotiate();
}

VideoPipe.prototype.negotiate = async function() {
  this.pc1.onicecandidate = e => this.pc2.addIceCandidate(e.candidate);
  this.pc2.onicecandidate = e => this.pc1.addIceCandidate(e.candidate);

  const offer = await this.pc1.createOffer({offerToReceiveAudio: true, offerToReceiveVideo: true});
  await this.pc2.setRemoteDescription(offer);
  await this.pc1.setLocalDescription(offer);

  const answer = await this.pc2.createAnswer();
  await this.pc1.setRemoteDescription(answer);
  await this.pc2.setLocalDescription(answer);
};

VideoPipe.prototype.close = function() {
  this.pc1.close();
  this.pc2.close();
};
