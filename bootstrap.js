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
const SANDBOX_HTML = "http://victorporof.github.io/YouTube-Animated-Thumbnails/embed.html";
const YOUTUBE_HOST = "www.youtube.com";

const VIDEO_WIDTH = 256;
const VIDEO_HEIGHT = 144;
const VIDEO_BACKGROUND = "#000";
const VIDEO_SAFE_BOUNDS = 300; // px
const SCREENSHOT_OFFSET_X = 0; // px
const SCREENSHOT_OFFSET_Y = 135; // px

const MOUSE_SETTLE_DELAY = 250; // milliseconds;
const SCREENSHOT_INTERVAL = 5; // seconds
const SCREENSHOT_DELAY = 50; // milliseconds

const gSandboxes = new Map();
const gRemovable = [];

// A list of node types considered thumbnail icons when hovered.
const THUMBNAIL_ELEMENT_TYPES = [
  "img"
];

// A list of immediate parent node selectors for the above node types.
// The 'depth' property specifies how many levels up a parent node is
// considered representative for the thumbnail bounds (x, y, width, height).
const THUMBNAIL_PARENT_SELECTORS = [
  { selector: "yt-thumb-clip",            depth: 2 },
  { selector: "yt-uix-simple-thumb-wrap", depth: 1 }
];

/**
 * Called when the extension needs to start itself up.
 */
function startup() {
  Services.obs.addObserver(onGlobalCreated, "content-document-global-created", false);
}

/**
 * Called when the extension needs to shut itself down.
 */
function shutdown(data, reason) {
  // When the application is shutting down we normally don't have to clean
  // up any UI changes made
  if (reason == APP_SHUTDOWN) {
    return;
  }

  Services.obs.removeObserver(onGlobalCreated, "content-document-global-created");

  gSandboxes.clear();
  gRemovable.forEach(e => e.remove());

  // For development.
  Services.obs.notifyObservers(null, "startupcache-invalidate", null);
}

/**
 * Observes when a content document global is created.
 *
 * @param nsIDOMWindow contentWin
 *        The content window being created.
 */
function onGlobalCreated(contentWin) {
  if (contentWin.location.host == YOUTUBE_HOST) {
    onYouTubeDomain(contentWin);
  }
}

/**
 * Called whenever YouTube is loaded in a content window.
 *
 * @parma nsIDOMWindow contentWin
 *        The content window holding the YouTube page.
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
   * Event listener for the "beforeunload" event on the content window.
   */
  function onBeforeUnload() {
    if (!sandbox) return;
    sandbox.hideThumbnail();
    clearNamedTimeout("yt-mouse-move");
  }

  /**
   * Event listener for the "mousemove" event on the content window.
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
   * Called whenever the mouse stops moving.
   *
   * @param nsIDOMNode hoveredNode
   *        The element currently being hovered.
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
   * Called whenever a thumbnail starts being hovered.
   *
   * @param nsIDOMNode hoveredNode
   *        The element currently being hovered.
   * @param number depth
   *        @see THUMBNAIL_PARENT_SELECTORS.
   */
  function onThumbnailImageMouseOver(hoveredNode, depth) {
    let boundsNode = hoveredNode;
    while (depth--) boundsNode = boundsNode.parentNode;

    let contentBounds = chromeWin.gBrowser.selectedBrowser.getBoundingClientRect();
    let imageBounds = boundsNode.getBoundingClientRect();
    sandbox.setThumbnailBounds(imageBounds, contentBounds.left, contentBounds.top);

    let id = /(?:http?s?:)?\/\/.*\/(.*?)\//.exec(hoveredNode.src).pop();
    sandbox.setVideo(id, onThumbnailUpdateable);
  }

  /**
   * Called whenever the thumbnail is allowed to be updated.
   */
  function onThumbnailUpdateable() {
    if (!sandbox) return;
    sandbox.updateThumbnail();
    clearNamedTimeout("yt-mouse-move");
  }

  /**
   * Event listener for the "scroll" and "wheel" events on the content window.
   */
  function onScroll() {
    if (!sandbox) return;
    sandbox.hideThumbnail();
    clearNamedTimeout("yt-mouse-move");
  }
}

/**
 * Gets (or creates if not already available) a YouTube video player sandbox
 * for the current browser window.
 *
 * @param nsIDOMWindow chromeWin
 *        The top level browser window.
 * @param function callback
 *        Invoked whenever the sandbox is available.
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
 * Creates a YouTube video player sandbox for the current browser window.
 *
 * @param nsIDOMWindow ownerWin
 *        The window owning the sandbox's iframe.
 * @param number width
 *        The width of the sandbox's iframe.
 * @param number height
 *        The height of the sandbox's iframe.
 * @param function callback
 *        Invoked whenever the sandbox is available.
 */
function createYouTubeSandbox(ownerWin, width, height, callback) {
  let frameParent = ownerWin.document.documentElement;
  let frameWidth = width;
  let frameHeight = height + VIDEO_SAFE_BOUNDS;
  let frameSrc = SANDBOX_HTML +
    "?width=" + frameWidth +
    "&height=" + frameHeight +
    "&interval=" + SCREENSHOT_INTERVAL +
    "&delay=" + SCREENSHOT_DELAY;

  createYouTubeSandboxIframe(frameParent, frameSrc, frameWidth, frameHeight, iframe => {
    let iframeWin = XPCNativeWrapper.unwrap(iframe.contentWindow);
    let thumbnailCanvas = createThumbnailCanvas(frameParent, width, height);
    let ctx = thumbnailCanvas.getContext("2d");

    iframeWin.getPlayer(p => callback({
      isPlaying: false,
      isVisible: false,

      /**
       * Starts playing a video in the sandbox's iframe.
       *
       * @param string id
       *        The YouTube video id, e.g. "dQw4w9WgXcQ".
       * @param function onThumbnailUpdateable
       *        Invoked whenever the playback pauses briefly allowing the
       *        thumbnail to be updated.
       */
      setVideo: function(id, onThumbnailUpdateable) {
        this.isPlaying = true;
        iframeWin.onScreenshotAllowed = onThumbnailUpdateable;
        p.loadVideoById(id, 0, "small");
      },

      /**
       * Stops playing the current video and hides the thumbnail.
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
       * Sets the thumbnail position.
       *
       * @param object { left, top, width, height }
       *        The desired thumbnail bounds.
       * @param number offsetX [optional]
       *        Optional left offset.
       * @param number offsetY [optional]
       *        Optional top offset.
       */
      setThumbnailBounds: function({ left, top, width, height }, offsetX = 0, offsetY = 0) {
        let ratioX = width / thumbnailCanvas.width;
        let ratioY = height / thumbnailCanvas.height;

        thumbnailCanvas.style.transform =
          "translate(" + (left + offsetX) + "px, " + (top + offsetY) + "px) " +
          "scale(" + ratioX + ", " + ratioY + ")";
      },

      /**
       * Shows the thumbnail and updates its contents.
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
 * Creates a YouTube video player sandbox, used to play videos and
 * generate thumbnails.
 *
 * @param nsIDOMNode parentNode
 *        The parent node which will contain the iframe.
 * @param string src
 *        The iframe source url.
 * @param number width
 *        The desired iframe width.
 * @param number height
 *        The desired iframe height.
 * @param function callback
 *        Invoked once the iframe's content is loaded.
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
  );

  iframe.src = src;

  parentNode.appendChild(iframe);
  gRemovable.push(iframe);
}

/**
 * Creates a thumbnail canvas, which will be displayed above of the
 * content window.
 *
 * @param nsIDOMNode parentNode
 *        The parent node which will contain the canvas.
 * @param number width
 *        The desired canvas width.
 * @param number height
 *        The desired canvas height.
 * @return nsIDOMNode
 *         The newly created and appended canvas node.
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
 * Gets the top level browser window from a content window.
 *
 * @param nsIDOMWindow innerWin
 *        The content window to query.
 * @return nsIDOMWindow
 *         The top level browser window.
 */
function getChromeWin(innerWin) {
  return innerWin
    .QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIWebNavigation)
    .QueryInterface(Ci.nsIDocShellTreeItem).rootTreeItem
    .QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindow);
}
