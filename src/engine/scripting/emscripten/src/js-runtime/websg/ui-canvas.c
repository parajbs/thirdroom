#include <string.h>
#include "../quickjs/cutils.h"
#include "../quickjs/quickjs.h"
#include "../../websg.h"
#include "./websg-js.h"
#include "./ui-canvas.h"
#include "./ui-flex.h"
#include "./vector2.h"

/**
 * Class Definition
 **/

static void js_websg_ui_canvas_finalizer(JSRuntime *rt, JSValue val) {
  WebSGUICanvasData *ui_canvas_data = JS_GetOpaque(val, js_websg_ui_canvas_class_id);

  if (ui_canvas_data) {
    js_free_rt(rt, ui_canvas_data);
  }
}

static JSClassDef js_websg_ui_canvas_class = {
  "UICanvas",
  .finalizer = js_websg_ui_canvas_finalizer
};

static JSValue js_websg_ui_canvas_get_root(JSContext *ctx, JSValueConst this_val) {
 WebSGUICanvasData *ui_canvas_data = JS_GetOpaque(this_val, js_websg_ui_canvas_class_id);

  ui_flex_id_t root_id = websg_ui_canvas_get_root(ui_canvas_data->ui_canvas_id);

  if (root_id == 0) {
    return JS_UNDEFINED;
  }

  return js_websg_get_ui_flex_by_id(ctx, ui_canvas_data->world_data, root_id);
}

static JSValue js_websg_ui_canvas_set_root(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WebSGUICanvasData *ui_canvas_data = JS_GetOpaque(this_val, js_websg_ui_canvas_class_id);
  
  ui_flex_id_t root_id;
  if (JS_ToUint32(ctx, &root_id, argv[1]) == -1) {
    return JS_EXCEPTION;
  }

  int32_t result = websg_ui_canvas_set_root(ui_canvas_data->ui_canvas_id, root_id);

  if (result == -1) {
    JS_ThrowInternalError(ctx, "WebSG UI: Error setting UI canvas root.");
    return JS_EXCEPTION;
  }

  return JS_UNDEFINED;
}

static float_t js_websg_ui_canvas_get_size_element(uint32_t ui_canvas_id, float_t *size, int index) {
  websg_ui_canvas_get_size(ui_canvas_id, size);
  return size[index];
}

static void js_websg_ui_canvas_set_size_element(uint32_t ui_canvas_id, float_t *size, int index, float_t value) {
  websg_ui_canvas_get_size(ui_canvas_id, size);
  size[index] = value;
  websg_ui_canvas_set_size(ui_canvas_id, size);
}

static JSValue js_websg_ui_canvas_get_width(JSContext *ctx, JSValueConst this_val) {
 WebSGUICanvasData *ui_canvas_data = JS_GetOpaque(this_val, js_websg_ui_canvas_class_id);

  float_t result = websg_ui_canvas_get_width(ui_canvas_data->ui_canvas_id);

  return JS_NewFloat64(ctx, result);
}

static JSValue js_websg_ui_canvas_set_width(JSContext *ctx, JSValueConst this_val, JSValueConst arg) {
  WebSGUICanvasData *ui_canvas_data = JS_GetOpaque(this_val, js_websg_ui_canvas_class_id);

  double_t value;

  if (JS_ToFloat64(ctx, &value, arg) == -1) {
    return JS_EXCEPTION;
  }

  int32_t result = websg_ui_canvas_set_width(ui_canvas_data->ui_canvas_id, (float_t)value);

  if (result == -1) {
    JS_ThrowInternalError(ctx, "WebSG: Error setting width.");
    return JS_EXCEPTION;
  }

  return JS_UNDEFINED;
}

static JSValue js_websg_ui_canvas_get_height(JSContext *ctx, JSValueConst this_val) {
 WebSGUICanvasData *ui_canvas_data = JS_GetOpaque(this_val, js_websg_ui_canvas_class_id);

  float_t result = websg_ui_canvas_get_height(ui_canvas_data->ui_canvas_id);

  return JS_NewFloat64(ctx, result);
}

static JSValue js_websg_ui_canvas_set_height(JSContext *ctx, JSValueConst this_val, JSValueConst arg) {
  WebSGUICanvasData *ui_canvas_data = JS_GetOpaque(this_val, js_websg_ui_canvas_class_id);

  double_t value;

  if (JS_ToFloat64(ctx, &value, arg) == -1) {
    return JS_EXCEPTION;
  }

  int32_t result = websg_ui_canvas_set_height(ui_canvas_data->ui_canvas_id, (float_t)value);

  if (result == -1) {
    JS_ThrowInternalError(ctx, "WebSG: Error setting height.");
    return JS_EXCEPTION;
  }

  return JS_UNDEFINED;
}

static JSValue js_websg_ui_canvas_redraw(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WebSGUICanvasData *ui_canvas_data = JS_GetOpaque(this_val, js_websg_ui_canvas_class_id);
  
  int32_t result = websg_ui_canvas_redraw(ui_canvas_data->ui_canvas_id);

  if (result == -1) {
    JS_ThrowInternalError(ctx, "WebSG UI: Error redrawing UI canvas.");
    return JS_EXCEPTION;
  }

  return JS_UNDEFINED;
}

static const JSCFunctionListEntry js_websg_ui_canvas_proto_funcs[] = {
  JS_CGETSET_DEF("root", js_websg_ui_canvas_get_root, js_websg_ui_canvas_set_root),
  JS_CGETSET_DEF("width", js_websg_ui_canvas_get_width, js_websg_ui_canvas_set_width),
  JS_CGETSET_DEF("height", js_websg_ui_canvas_get_height, js_websg_ui_canvas_set_height),
  JS_CFUNC_DEF("redraw", 0, js_websg_ui_canvas_redraw),
  JS_PROP_STRING_DEF("[Symbol.toStringTag]", "UICanvas", JS_PROP_CONFIGURABLE),
};

static JSValue js_websg_ui_canvas_constructor(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  return JS_ThrowTypeError(ctx, "Illegal Constructor.");
}

void js_websg_define_ui_canvas(JSContext *ctx, JSValue websg) {
  JS_NewClassID(&js_websg_ui_canvas_class_id);
  JS_NewClass(JS_GetRuntime(ctx), js_websg_ui_canvas_class_id, &js_websg_ui_canvas_class);
  JSValue ui_canvas_proto = JS_NewObject(ctx);
  JS_SetPropertyFunctionList(ctx, ui_canvas_proto, js_websg_ui_canvas_proto_funcs, countof(js_websg_ui_canvas_proto_funcs));
  JS_SetClassProto(ctx, js_websg_ui_canvas_class_id, ui_canvas_proto);

  JSValue constructor = JS_NewCFunction2(
    ctx,
    js_websg_ui_canvas_constructor,
    "UICanvas",
    0,
    JS_CFUNC_constructor,
    0
  );
  JS_SetConstructor(ctx, constructor, ui_canvas_proto);
  JS_SetPropertyStr(
    ctx,
    websg,
    "UICanvas",
    constructor
  );
}

JSValue js_websg_new_ui_canvas_instance(JSContext *ctx, WebSGWorldData *world_data, ui_canvas_id_t ui_canvas_id) {
  JSValue ui_canvas = JS_NewObjectClass(ctx, js_websg_ui_canvas_class_id);

  if (JS_IsException(ui_canvas)) {
    return ui_canvas;
  }

  js_websg_define_vector2_prop(
    ctx,
    ui_canvas,
    "size",
    ui_canvas_id,
    &js_websg_ui_canvas_get_size_element,
    &js_websg_ui_canvas_set_size_element
  );

  WebSGUICanvasData *ui_canvas_data = js_mallocz(ctx, sizeof(WebSGUICanvasData));
  ui_canvas_data->world_data = world_data;
  ui_canvas_data->ui_canvas_id = ui_canvas_id;
  JS_SetOpaque(ui_canvas, ui_canvas_data);

  JS_SetPropertyUint32(ctx, world_data->ui_canvases, ui_canvas_id, JS_DupValue(ctx, ui_canvas));
  
  return ui_canvas;
}

/**
 * Public Methods
 **/

JSValue js_websg_get_ui_canvas_by_id(JSContext *ctx, WebSGWorldData *world_data, ui_canvas_id_t ui_canvas_id) {
  JSValue ui_canvas = JS_GetPropertyUint32(ctx, world_data->ui_canvases, ui_canvas_id);

  if (!JS_IsUndefined(ui_canvas)) {
    return JS_DupValue(ctx, ui_canvas);
  }

  return js_websg_new_ui_canvas_instance(ctx, world_data, ui_canvas_id);
}

/**
 * World Methods
 **/

static JSValue js_websg_world_create_ui_canvas(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WebSGWorldData *world_data = JS_GetOpaque(this_val, js_websg_world_class_id);

  UICanvasProps *props = js_mallocz(ctx, sizeof(UICanvasProps));

  JSValue root_val = JS_GetPropertyStr(ctx, argv[0], "root");

  if (!JS_IsUndefined(root_val)) {
    WebSGUIFlexData *ui_flex_data = JS_GetOpaque2(ctx, root_val, js_websg_ui_flex_class_id);

    if (ui_flex_data == NULL) {
      return JS_EXCEPTION;
    }

    props->root = ui_flex_data->ui_flex_id;
  }

  JSValue size_val = JS_GetPropertyStr(ctx, argv[0], "size");

  if (!JS_IsUndefined(size_val)) {
    if (js_get_float_array_like(ctx, size_val, props->size, 2) < 0) {
      return JS_EXCEPTION;
    }
  }

  JSValue width_val = JS_GetPropertyStr(ctx, argv[0], "width");

  if (!JS_IsUndefined(width_val)) {
    double width;

    if (JS_ToFloat64(ctx, &width, width_val) == -1) {
      return JS_EXCEPTION;
    }

    props->width = (float_t)width;
  }

  JSValue height_val = JS_GetPropertyStr(ctx, argv[0], "height");

  if (!JS_IsUndefined(height_val)) {
    double height;

    if (JS_ToFloat64(ctx, &height, height_val) == -1) {
      return JS_EXCEPTION;
    }

    props->height = (float_t)height;
  }

  ui_canvas_id_t ui_canvas_id = websg_create_ui_canvas(props);

  if (ui_canvas_id == 0) {
    JS_ThrowInternalError(ctx, "WebSG UI: Error creating UI canvas.");
    return JS_EXCEPTION;
  }

  return js_websg_new_ui_canvas_instance(ctx, world_data, ui_canvas_id);
}
