const elements = {
  selection: document.querySelector("#selection"),
  count: document.querySelector("#count"),
  import: document.querySelector("#import"),
  track: document.querySelector("#track"),
  strip: document.querySelector("#strip"),
  previous: document.querySelector("#previous"),
  next: document.querySelector("#next")
};

let items = [];
let activeIndex = 0;
let activeAlbumKey = "";
let scrollingTimer = 0;
let pointerGesture = null;
let pendingOpen = null;
const dragThreshold = 5;
const doubleClickDelay = 320;

function mediaLabel(item) {
  const lines = [item.title, item.artist, item.album].filter(Boolean);
  return lines.join(" - ") || (item.mediaType === "pdf" ? "PDF" : "Artwork");
}

function setActive(index, shouldScroll = false) {
  if (!items.length) {
    activeIndex = 0;
    elements.selection.textContent = "暂无媒体";
    elements.previous.disabled = true;
    elements.next.disabled = true;
    return;
  }

  activeIndex = Math.max(0, Math.min(items.length - 1, index));
  elements.selection.textContent = mediaLabel(items[activeIndex]);
  elements.previous.disabled = activeIndex === 0;
  elements.next.disabled = activeIndex === items.length - 1;

  for (const [thumbIndex, thumbnail] of Array.from(elements.strip.children).entries()) {
    thumbnail.classList.toggle("selected", thumbIndex === activeIndex);
  }

  if (shouldScroll) {
    elements.track.children[activeIndex]?.scrollIntoView({
      block: "nearest",
      inline: "center",
      behavior: "smooth"
    });
    elements.strip.children[activeIndex]?.scrollIntoView({
      block: "nearest",
      inline: "center",
      behavior: "smooth"
    });
  }
}

function createPreview(item) {
  const media = document.createElement("div");
  media.className = `media ${item.mediaType}`;
  media.dataset.filePath = item.filePath;

  if (item.mediaType === "pdf") {
    const pdf = document.createElement("object");
    pdf.data = item.fileUrl;
    pdf.type = "application/pdf";
    media.appendChild(pdf);
  } else {
    const image = document.createElement("img");
    image.src = item.fileUrl;
    image.alt = mediaLabel(item);
    image.draggable = false;
    media.appendChild(image);
  }
  return media;
}

function render(nextItems) {
  items = nextItems || [];
  const nextAlbumKey = items[0]?.albumKey || "";
  if (nextAlbumKey !== activeAlbumKey) {
    activeIndex = 0;
    activeAlbumKey = nextAlbumKey;
  }
  document.querySelector(".library").classList.toggle("is-empty", !items.length);
  activeIndex = Math.min(activeIndex, Math.max(items.length - 1, 0));
  elements.track.replaceChildren();
  elements.strip.replaceChildren();
  elements.count.textContent = String(items.length);

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "当前专辑暂无其他图片或文档";
    elements.track.appendChild(empty);
    setActive(0);
    return;
  }

  for (const [index, item] of items.entries()) {
    const slide = document.createElement("article");
    slide.className = "slide";
    slide.appendChild(createPreview(item));
    elements.track.appendChild(slide);

    const thumbnail = document.createElement("button");
    thumbnail.className = "thumbnail";
    thumbnail.type = "button";
    thumbnail.setAttribute("aria-label", mediaLabel(item));
    thumbnail.addEventListener("click", () => setActive(index, true));
    if (item.mediaType === "pdf") {
      const badge = document.createElement("span");
      badge.className = "pdf-mark";
      badge.textContent = "PDF";
      thumbnail.appendChild(badge);
    } else {
      const image = document.createElement("img");
      image.src = item.fileUrl;
      image.alt = "";
      image.draggable = false;
      thumbnail.appendChild(image);
    }
    elements.strip.appendChild(thumbnail);
  }

  setActive(activeIndex, true);
}

function selectFromScroll() {
  if (!items.length) return;
  const index = Math.round(elements.track.scrollLeft / elements.track.clientWidth);
  setActive(index);
}

elements.track.addEventListener("scroll", () => {
  clearTimeout(scrollingTimer);
  scrollingTimer = setTimeout(selectFromScroll, 70);
});
elements.track.addEventListener("wheel", (event) => {
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    elements.track.scrollBy({ left: event.deltaY, behavior: "smooth" });
    event.preventDefault();
  }
}, { passive: false });
elements.previous.addEventListener("click", () => setActive(activeIndex - 1, true));
elements.next.addEventListener("click", () => setActive(activeIndex + 1, true));
elements.import.addEventListener("click", () => window.roonMonitor.importGalleryItems().then(render));

document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  pointerGesture = {
    pointerId: event.pointerId,
    mediaPath: event.target.closest(".media")?.dataset.filePath || "",
    startX: event.screenX,
    startY: event.screenY,
    lastX: event.screenX,
    lastY: event.screenY,
    dragging: false
  };
  event.target.setPointerCapture?.(event.pointerId);
});

document.addEventListener("pointermove", (event) => {
  if (!pointerGesture || pointerGesture.pointerId !== event.pointerId) return;
  const travel = Math.hypot(
    event.screenX - pointerGesture.startX,
    event.screenY - pointerGesture.startY
  );
  if (!pointerGesture.dragging && travel >= dragThreshold) {
    pointerGesture.dragging = true;
    pendingOpen = null;
  }
  if (!pointerGesture.dragging) return;
  event.preventDefault();
  const deltaX = event.screenX - pointerGesture.lastX;
  const deltaY = event.screenY - pointerGesture.lastY;
  pointerGesture.lastX = event.screenX;
  pointerGesture.lastY = event.screenY;
  if (deltaX || deltaY) {
    window.roonMonitor.moveGalleryWindowBy(deltaX, deltaY);
  }
});

document.addEventListener("pointerup", (event) => {
  if (!pointerGesture || pointerGesture.pointerId !== event.pointerId) return;
  const released = pointerGesture;
  pointerGesture = null;
  if (released.dragging || !released.mediaPath) return;

  const now = Date.now();
  if (pendingOpen?.filePath === released.mediaPath && now - pendingOpen.time <= doubleClickDelay) {
    pendingOpen = null;
    window.roonMonitor.openGalleryItem(released.mediaPath);
    return;
  }
  pendingOpen = { filePath: released.mediaPath, time: now };
});

document.addEventListener("pointercancel", () => {
  pointerGesture = null;
});

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") setActive(activeIndex - 1, true);
  if (event.key === "ArrowRight") setActive(activeIndex + 1, true);
  if (event.key === "Enter" && items[activeIndex]) {
    window.roonMonitor.openGalleryItem(items[activeIndex].filePath);
  }
});

window.roonMonitor.onGalleryItems(render);
window.roonMonitor.listGalleryItems().then(render);
