// The game's code calls these functions (they used to talk to an ad/portal SDK).
// This site has no ads, so they do nothing except tell the game "no ads here"
// and draw the loading bar.
function poki_init_raw() {
    var ctr = document.getElementById("gm4html5_div_id");
    if (ctr && !ctr.frames) ctr.frames = []; // GameMaker iframe bug fix
    return 0; // 0 = no SDK, the game skips its ad setup
}
function poki_script_closure_raw(self, other, script, custom) {
    return function (result) {
        window.gml_Script_gmcallback_poki_closure(self, other, script, result, custom);
    };
}
function poki_is_blocked() { return true; }
function poki_gameplay_start() {}
function poki_gameplay_stop() {}
function poki_happy_time() {}
function poki_commercial_break_raw(fn) { setTimeout(function () { fn(false); }, 0); }
function poki_rewarded_break_raw(fn) { setTimeout(function () { fn(false); }, 0); }

// Loading bar shown while the game downloads.
var inst = {};
function poki_loadbar(ctx, width, height, total, current, image) {
    function getv(s) {
        return window.gml_Script_gmcallback_poki_loadbar
            ? window.gml_Script_gmcallback_poki_loadbar(inst, null, s, current, total,
                width, height, image ? image.width : 0, image ? image.height : 0)
            : undefined;
    }
    function getf(s, d) { var r = getv(s); return typeof r == "number" ? r : d; }
    function getw(s, d) { var r = getv(s); return r && r.constructor == Array ? r : d; }
    function getc(s, d) {
        var r = getv(s);
        if (typeof r == "number") { r = r.toString(16); while (r.length < 6) r = "0" + r; return "#" + r; }
        return typeof r == "string" ? r : d;
    }
    var backgroundColor = getc("background_color", "#FFFFFF");
    var barBackgroundColor = getc("bar_background_color", "#FFFFFF");
    var barForegroundColor = getc("bar_foreground_color", "#242238");
    var barBorderColor = getc("bar_border_color", "#242238");
    var barWidth = getf("bar_width", Math.round(width * 0.6));
    var barHeight = getf("bar_height", 20);
    var barBorderWidth = getf("bar_border_width", 2);
    var barOffset = getf("bar_offset", 10);
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);
    var barTop;
    if (image != null) {
        var rect = getw("image_rect") || [0, 0, image.width, image.height];
        var imageY = (height - (rect[3] + barOffset + barHeight)) >> 1;
        ctx.drawImage(image, rect[0], rect[1], rect[2], rect[3], (width - rect[2]) >> 1, imageY, rect[2], rect[3]);
        barTop = imageY + rect[3] + barOffset;
    } else barTop = (height - barHeight) >> 1;
    var barLeft = (width - barWidth) >> 1;
    ctx.fillStyle = barBorderColor;
    ctx.fillRect(barLeft, barTop, barWidth, barHeight);
    var innerW = barWidth - barBorderWidth * 2, innerH = barHeight - barBorderWidth * 2;
    ctx.fillStyle = barBackgroundColor;
    ctx.fillRect(barLeft + barBorderWidth, barTop + barBorderWidth, innerW, innerH);
    ctx.fillStyle = barForegroundColor;
    ctx.fillRect(barLeft + barBorderWidth, barTop + barBorderWidth, Math.round(innerW * current / total), innerH);
}
