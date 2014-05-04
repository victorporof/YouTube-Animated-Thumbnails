/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const Cu = Components.utils;
const Ci = Components.interfaces;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/devtools/LayoutHelpers.jsm");
Cu.import("resource:///modules/devtools/ViewHelpers.jsm");

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SANDBOX_HTML = "FIXME";
const YOUTUBE_HOST = "www.youtube.com";

const VIDEO_WIDTH = 256;
const VIDEO_HEIGHT = 144;
const VIDEO_BACKGROUND = "#000";
const VIDEO_SAFE_BOUNDS = 300; // px
const SCREENSHOT_OFFSET_X = 0; // px
const SCREENSHOT_OFFSET_Y = 135; // px

const MOUSE_SETTLE_DELAY = 250; // milliseconds;
const SCREENSHOT_DELAY = 50; // milliseconds
const SCREENSHOT_INTERVAL = 5; // seconds


const THUMBNAIL_ELEMENT_TYPES = [
  "img"
];
const THUMBNAIL_PARENT_SELECTORS = [
  { selector: "yt-thumb-clip",            depth: 2 },
  { selector: "yt-uix-simple-thumb-wrap", depth: 1 }
];

const gSandboxes = new Map();
const gRemovable = [];

/**
 *
 */
function startup() {
  Services.obs.addObserver(onGlobalCreated, "content-document-global-created", false);
}

/**
 *
 */
function shutdown() {
  Services.obs.removeObserver(onGlobalCreated, "content-document-global-created");

  gSandboxes.clear();
  gRemovable.forEach(e => e.remove());

  // For development.
  Services.obs.notifyObservers(null, "startupcache-invalidate", null);
}

/**
 *
 */
function onGlobalCreated(contentWin) {
  if (contentWin.location.host == YOUTUBE_HOST) {
    onYouTubeDomain(contentWin);
  }
}

/**
 *
 */
function onYouTubeDomain(contentWin) {
  let chromeWin = getChromeWin(contentWin);
  let layout = new LayoutHelpers(contentWin);
  let sandbox;

  getYouTubeSandboxFor(chromeWin, s => sandbox = s);
  contentWin.addEventListener("beforeunload", onBeforeUnload);
  contentWin.addEventListener("mousemove", onMouseMove);
  contentWin.addEventListener("scroll", onScroll);
  contentWin.addEventListener("wheel", onScroll);

  /**
   *
   */
  function onBeforeUnload() {
    if (!sandbox) return;
    sandbox.hideThumbnail();
    clearNamedTimeout("yt-mouse-move");
  }

  /**
   *
   */
  function onMouseMove(e) {
    if (!sandbox) return;

    let x = e.clientX;
    let y = e.clientY;
    let hoveredNode = layout.getElementFromPoint(contentWin.document, x, y);
    if (hoveredNode == sandbox.hoveredNode) {
      return;
    }

    sandbox.hoveredNode = hoveredNode;
    sandbox.hideThumbnail();
    setNamedTimeout("yt-mouse-move", MOUSE_SETTLE_DELAY, () => onMouseSettled(hoveredNode));
  }

  /**
   *
   */
  function onMouseSettled(hoveredNode) {
    let { localName, parentNode } = hoveredNode;

    for (let type of THUMBNAIL_ELEMENT_TYPES) {
      if (localName != type) {
        continue;
      }
      for (let thumbnail of THUMBNAIL_PARENT_SELECTORS) {
        if (!parentNode.classList.contains(thumbnail.selector)) {
          continue;
        }
        onThumbnailImageMouseOver(hoveredNode, thumbnail.depth);
        return;
      }
    }
  }

  /**
   *
   */
  function onThumbnailImageMouseOver(targetNode, depth) {
    let boundsNode = targetNode;
    while (depth--) boundsNode = boundsNode.parentNode;

    let contentBounds = chromeWin.gBrowser.selectedBrowser.getBoundingClientRect();
    let imageBounds = boundsNode.getBoundingClientRect();
    sandbox.setThumbnailBounds(imageBounds, contentBounds.left, contentBounds.top);

    let id = /(?:http?s?:)?\/\/.*\/(.*?)\//.exec(targetNode.src).pop();
    sandbox.setVideo(id, onScreenshotAllowed);
  }

  /**
   *
   */
  function onScroll() {
    if (!sandbox) return;
    sandbox.hideThumbnail();
    clearNamedTimeout("yt-mouse-move");
  }

  /**
   *
   */
  function onScreenshotAllowed() {
    if (!sandbox) return;
    sandbox.updateThumbnail();
    clearNamedTimeout("yt-mouse-move");
  }
}

/**
 *
 */
function getYouTubeSandboxFor(chromeWin, callback) {
  if (gSandboxes.has(chromeWin)) {
    callback(gSandboxes.get(chromeWin));
    return;
  }

  createYouTubeSandbox(chromeWin, VIDEO_WIDTH, VIDEO_HEIGHT, sandbox => {
    gSandboxes.set(chromeWin, sandbox);
    callback(sandbox);
  });
}

/**
 *
 */
function createYouTubeSandbox(ownerWin, width, height, callback) {
  let frameParent = ownerWin.document.documentElement;
  let frameWidth = width;
  let frameHeight = height + VIDEO_SAFE_BOUNDS;
  let frameSrc = SANDBOX_HTML +
    "?width=" + frameWidth +
    "&height=" + frameHeight +
    "&delay=" + SCREENSHOT_DELAY +
    "&interval=" + SCREENSHOT_INTERVAL;

  createYouTubeSandboxIframe(frameParent, frameSrc, frameWidth, frameHeight, iframe => {
    let iframeWin = XPCNativeWrapper.unwrap(iframe.contentWindow);
    let thumbnailCanvas = createThumbnailCanvas(frameParent, width, height);
    let ctx = thumbnailCanvas.getContext("2d");

    iframeWin.getPlayer(p => callback({
      /**
       *
       */
      isPlaying: false,
      isVisible: false,

      /**
       *
       */
      setVideo: function(id, onScreenshotAllowed) {
        this.isPlaying = true;
        iframeWin.onScreenshotAllowed = onScreenshotAllowed;

        p.loadVideoById(id, 0, "small");
      },

      /**
       *
       */
      hideThumbnail: function() {
        if (this.isVisible) {
          this.isVisible = false;
          thumbnailCanvas.hidden = true;
        }
        if (this.isPlaying) {
          this.isPlaying = false;
          p.pauseVideo();
        }
      },

      /**
       *
       */
      setThumbnailBounds: function({ left, top, width, height }, offsetX, offsetY) {
        let ratioX = width / thumbnailCanvas.width;
        let ratioY = height / thumbnailCanvas.height;

        thumbnailCanvas.style.transform =
          "translate(" + (left + offsetX) + "px, " + (top + offsetY) + "px) " +
          "scale(" + ratioX + ", " + ratioY + ")";
      },

      /**
       *
       */
      updateThumbnail: function() {
        ctx.drawWindow(iframeWin,
          SCREENSHOT_OFFSET_X, SCREENSHOT_OFFSET_Y,
          VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_BACKGROUND);

        if (!this.isVisible) {
          this.isVisible = true;
          thumbnailCanvas.hidden = false;
        }
      }
    }));
  });
}

/**
 *
 */
function createYouTubeSandboxIframe(parentNode, src, width, height, callback) {
  let iframe = parentNode.ownerDocument.createElementNS(HTML_NS, "iframe");

  iframe.addEventListener("DOMContentLoaded", function onLoad() {
    iframe.removeEventListener("DOMContentLoaded", onLoad);
    callback(iframe);
  });

  iframe.setAttribute("width", width);
  iframe.setAttribute("height", height);
  iframe.setAttribute("frameborder", "0");
  iframe.setAttribute("style",
    "position: fixed;" +
    "right: -" + (width - 1) + "px;" +
    "bottom: -" + (height - 1) + "px;"
    // "right: 0px;" +
    // "bottom: 0px;"
  );

  iframe.src = src;

  parentNode.appendChild(iframe);
  gRemovable.push(iframe);
}

/**
 *
 */
function createThumbnailCanvas(parentNode, width, height) {
  let canvas = parentNode.ownerDocument.createElementNS(HTML_NS, "canvas");
  canvas.setAttribute("style",
    "position: fixed;" +
    "top: 0px;" +
    "left: 0px;" +
    "transform-origin: left top;" +
    "image-rendering: -moz-crisp-edges;" +
    "pointer-events: none;"
  );

  canvas.width = width;
  canvas.height = height;

  parentNode.appendChild(canvas);
  gRemovable.push(canvas);

  return canvas;
}

/**
 *
 */
function getChromeWin(innerWin) {
  return innerWin
    .QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIWebNavigation)
    .QueryInterface(Ci.nsIDocShellTreeItem).rootTreeItem
    .QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindow);
}
