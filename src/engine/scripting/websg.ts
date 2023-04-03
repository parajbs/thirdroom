import { hasComponent } from "bitecs";
import RAPIER from "@dimforge/rapier3d-compat";
import { BoxGeometry } from "three";

import { GameState } from "../GameTypes";
import { IRemoteResourceClass, RemoteResourceConstructor } from "../resource/RemoteResourceClass";
import { getRemoteResources } from "../resource/resource.game";
import {
  readFloat32ArrayInto,
  readSharedArrayBuffer,
  readString,
  readStringFromCursorView,
  readUint8Array,
  WASMModuleContext,
  writeFloat32Array,
} from "./WASMModuleContext";
import {
  RemoteAccessor,
  RemoteBuffer,
  RemoteBufferView,
  RemoteCamera,
  RemoteCollider,
  RemoteInteractable,
  RemoteLight,
  RemoteMaterial,
  RemoteMesh,
  RemoteMeshPrimitive,
  RemoteNode,
  RemoteScene,
  RemoteSkin,
  RemoteTexture,
  RemoteUIButton,
  RemoteUICanvas,
  RemoteUIElement,
  RemoteUIText,
} from "../resource/RemoteResources";
import { addChild, removeChild, traverse } from "../component/transform";
import {
  AccessorComponentType,
  AccessorType,
  ColliderType,
  InteractableType,
  LightType,
  MaterialType,
  MeshPrimitiveAttributeIndex,
  MeshPrimitiveMode,
  PhysicsBodyType,
  ResourceType,
} from "../resource/schema";
import {
  CursorView,
  moveCursorView,
  readFloat32,
  readFloat32Array,
  readUint32,
  readUint32Array,
  skipUint32,
  writeUint32,
} from "../allocator/CursorView";
import { AccessorComponentTypeToTypedArray, AccessorTypeToElementSize } from "../accessor/accessor.common";
import {
  addRigidBody,
  createNodeColliderDesc,
  PhysicsModule,
  removeRigidBody,
  RigidBody,
} from "../physics/physics.game";
import { getModule } from "../module/module.common";
import { createMesh } from "../mesh/mesh.game";
import { addInteractableComponent } from "../../plugins/interaction/interaction.game";
import { dynamicObjectCollisionGroups } from "../physics/CollisionGroups";
import { addUIElementChild } from "../ui/ui.game";
import { startOrbit, stopOrbit } from "../../plugins/camera/CameraRig.game";

export function getScriptResource<T extends RemoteResourceConstructor>(
  wasmCtx: WASMModuleContext,
  resourceConstructor: T,
  resourceId: number
): InstanceType<T> | undefined {
  const { resourceIds, resourceMap } = wasmCtx.resourceManager;
  const { name, resourceType } = resourceConstructor.resourceDef;

  if (!resourceIds.has(resourceId)) {
    console.error(`WebSG: missing or unpermitted use of ${name}: ${resourceId}`);
    return undefined;
  }

  const resource = resourceMap.get(resourceId) as InstanceType<T> | undefined;

  if (!resource) {
    console.error(`WebSG: missing ${name}: ${resourceId}`);
    return undefined;
  }

  if (resource.resourceType !== resourceType) {
    console.error(`WebSG: id does not point to a ${name}: ${resourceId}`);
    return undefined;
  }

  return resource;
}

function getScriptResourceByName<T extends RemoteResourceConstructor>(
  ctx: GameState,
  wasmCtx: WASMModuleContext,
  resourceConstructor: T,
  name: string
): InstanceType<T> | undefined {
  const resources = getRemoteResources(ctx, resourceConstructor as IRemoteResourceClass<T["resourceDef"]>);

  const resourceIds = wasmCtx.resourceManager.resourceIds;

  for (let i = 0; i < resources.length; i++) {
    const resource = resources[i];

    if (resource.name === name && resourceIds.has(resource.eid)) {
      return resource as InstanceType<T>;
    }
  }

  return undefined;
}

function getScriptResourceByNamePtr<T extends RemoteResourceConstructor>(
  ctx: GameState,
  wasmCtx: WASMModuleContext,
  resourceConstructor: T,
  namePtr: number,
  byteLength: number
): InstanceType<T> | undefined {
  const name = readString(wasmCtx, namePtr, byteLength);
  return getScriptResourceByName(ctx, wasmCtx, resourceConstructor, name);
}

function getScriptResourceRef<T extends RemoteResourceConstructor>(
  wasmCtx: WASMModuleContext,
  resourceConstructor: T,
  refResource: InstanceType<T> | undefined
): number {
  if (!refResource) {
    return 0;
  }

  const resourceId = refResource.eid;

  if (!wasmCtx.resourceManager.resourceIds.has(resourceId)) {
    console.error(`WebSG: missing or unpermitted use of ${resourceConstructor.name}: ${resourceId}`);
    return 0;
  }

  return resourceId;
}

function getScriptChildCount(wasmCtx: WASMModuleContext, node: RemoteNode | RemoteScene): number {
  const resourceIds = wasmCtx.resourceManager.resourceIds;

  let count = 0;
  let cursor = node.resourceType === ResourceType.Node ? node.firstChild : node.firstNode;

  while (cursor) {
    // Only count the resources owned by the script.
    if (resourceIds.has(cursor.eid)) {
      count++;
    }

    cursor = cursor.nextSibling;
  }

  return count;
}

function getScriptChildren(
  wasmCtx: WASMModuleContext,
  node: RemoteNode | RemoteScene,
  nodeArrPtr: number,
  maxCount: number
): number {
  const resourceIds = wasmCtx.resourceManager.resourceIds;
  const U32Heap = wasmCtx.U32Heap;

  let i = 0;
  let cursor = node.resourceType === ResourceType.Node ? node.firstChild : node.firstNode;

  while (cursor && i < maxCount) {
    // Only write the resources owned by the script.
    if (resourceIds.has(cursor.eid)) {
      U32Heap[nodeArrPtr / 4 + i] = cursor.eid;
      i++;
    }

    cursor = cursor.nextSibling;
  }

  // Return the number of ids written into the array
  return i;
}

function scriptGetChildAt(wasmCtx: WASMModuleContext, parent: RemoteNode | RemoteScene, index: number): number {
  const resourceIds = wasmCtx.resourceManager.resourceIds;

  let i = 0;
  let cursor = parent.resourceType === ResourceType.Node ? parent.firstChild : parent.firstNode;

  while (cursor && i < index) {
    // Only count the resources owned by the script.
    if (resourceIds.has(cursor.eid)) {
      i++;
    }

    cursor = cursor.nextSibling;
  }

  if (i === index && cursor && resourceIds.has(cursor.eid)) {
    return cursor.eid;
  }

  return 0;
}

function readExtensions(
  wasmCtx: WASMModuleContext,
  parseExtension: (wasmCtx: WASMModuleContext, name: string) => any = () => {}
) {
  const itemsPtr = readUint32(wasmCtx.cursorView);
  const count = readUint32(wasmCtx.cursorView);

  const extensionItemLength = 8;

  const extensions: { [key: string]: any } = {};

  for (let i = 0; i < count; i++) {
    moveCursorView(wasmCtx.cursorView, itemsPtr + i * extensionItemLength);
    const name = readStringFromCursorView(wasmCtx);
    extensions[name] = parseExtension(wasmCtx, name);
  }

  return extensions;
}

<<<<<<< Updated upstream
function readExtras(cursorView: CursorView) {
=======
function skipExtras(cursorView: CursorView) {
>>>>>>> Stashed changes
  skipUint32(cursorView);
  skipUint32(cursorView);
}

function readTextureRef(wasmCtx: WASMModuleContext) {
  const textureId = readUint32(wasmCtx.cursorView);

  let texture: RemoteTexture | undefined;

  if (textureId) {
    texture = getScriptResource(wasmCtx, RemoteTexture, textureId);
  }

  return texture;
}

function readTextureInfoExtensions(wasmCtx: WASMModuleContext) {
  return readExtensions(wasmCtx, (wasmCtx, name) => {
    if (name == "KHR_textures_transform") {
      const offset = readFloat32Array(wasmCtx.cursorView, 2);
      const rotation = readFloat32(wasmCtx.cursorView);
      const scale = readFloat32Array(wasmCtx.cursorView, 2);
      const texCoord = readUint32(wasmCtx.cursorView);

      return { offset, rotation, scale, texCoord };
    }

    return {};
  });
}

<<<<<<< Updated upstream
function readTextureInfo(wasmCtx: WASMModuleContext) {
  

  skipUint32(wasmCtx.cursorView); // skip texCoord
  const extensions readTextureInfoExtensions(wasmCtx);
  readExtras(wasmCtx.cursorView);

  return texture;
=======
// MaterialTextureInfoProps
function readTextureInfo(wasmCtx: WASMModuleContext) {
  readTextureRef(wasmCtx);
  skipUint32(wasmCtx.cursorView); // skip texCoord
  const { KHR_textures_transform: { offset, rotation, scale, texCoord } = {} } = readTextureInfoExtensions(wasmCtx);
  skipExtras(wasmCtx.cursorView);

  return { texture, extensions };
>>>>>>> Stashed changes
}

function readNormalTextureInfo(wasmCtx: WASMModuleContext) {
  const textureId = readUint32(wasmCtx.cursorView);

  let normalTexture: RemoteTexture | undefined;

  if (textureId) {
    normalTexture = getScriptResource(wasmCtx, RemoteTexture, textureId);
  }

  skipUint32(wasmCtx.cursorView); // skip texCoord

  const normalScale = readFloat32(wasmCtx.cursorView);

  const extensions = readExtensions(wasmCtx, parseKHRTexturesTransformExtension);
  readExtras(wasmCtx.cursorView);

  if (extensions.KHR_textures_transform) {
    const { offset, rotation, scale } = extensions.KHR_textures_transform;

    return {
      normalTexture,
      normalScale,
      normalTextureOffset: offset,
      normalTextureRotation: rotation,
      normalTextureScale: scale,
    };
  }

  return { normalTexture, normalScale };
}

function readOcclusionTextureInfo(wasmCtx: WASMModuleContext) {
  const textureId = readUint32(wasmCtx.cursorView);

  let occlusionTexture: RemoteTexture | undefined;

  if (textureId) {
    occlusionTexture = getScriptResource(wasmCtx, RemoteTexture, textureId);
  }

  skipUint32(wasmCtx.cursorView); // skip texCoord

  const occlusionStrength = readFloat32(wasmCtx.cursorView);

  const extensions = readExtensions(wasmCtx, parseKHRTexturesTransformExtension);
  readExtras(wasmCtx.cursorView);

  if (extensions.KHR_textures_transform) {
    const { offset, rotation, scale } = extensions.KHR_textures_transform;

    return {
      occlusionTexture,
      occlusionStrength,
      occlusionTextureOffset: offset,
      occlusionTextureRotation: rotation,
      occlusionTextureScale: scale,
    };
  }

  return { occlusionTexture, occlusionStrength };
}

interface MeshPrimitiveProps {
  attributes: { [key: number]: RemoteAccessor };
  indices?: RemoteAccessor;
  material?: RemoteMaterial;
  mode: MeshPrimitiveMode;
}

// TODO: ResourceManager should have a resourceMap that corresponds to just its owned resources
// TODO: ResourceManager should have a resourceByType that corresponds to just its owned resources
// TODO: Force disposal of all entities belonging to the wasmCtx when environment unloads
// TODO: When do we update local / world matrices?
// TODO: the mesh.primitives array is allocated whenever we request it but it's now immutable

export function createWebSGModule(ctx: GameState, wasmCtx: WASMModuleContext) {
  const physics = getModule(ctx, PhysicsModule);

  return {
    world_get_environment() {
      return ctx.worldResource.environment?.publicScene.eid || 0;
    },
    world_set_environment(sceneId: number) {
      if (!ctx.worldResource.environment) {
        console.error(`WebSG: environment not set`);
        return -1;
      }

      const scene = getScriptResource(wasmCtx, RemoteScene, sceneId);

      if (scene) {
        ctx.worldResource.environment.publicScene = scene;
        return 0;
      } else {
        return -1;
      }
    },
    world_create_scene(propsPtr: number) {
      try {
        moveCursorView(wasmCtx.cursorView, propsPtr);
        const name = readStringFromCursorView(wasmCtx);
        return new RemoteScene(wasmCtx.resourceManager, {
          name,
        }).eid;
      } catch (error) {
        console.error("WebSG: Error creating scene:", error);
        return 0;
      }
    },
    world_find_scene_by_name(namePtr: number, byteLength: number) {
      const scene = getScriptResourceByNamePtr(ctx, wasmCtx, RemoteScene, namePtr, byteLength);
      return scene ? scene.eid : 0;
    },
    scene_add_node(sceneId: number, nodeId: number) {
      const scene = getScriptResource(wasmCtx, RemoteScene, sceneId);

      if (!scene) {
        return -1;
      }

      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      addChild(scene, node);

      return 0;
    },
    scene_remove_node(sceneId: number, nodeId: number) {
      const scene = getScriptResource(wasmCtx, RemoteScene, sceneId);

      if (!scene) {
        return -1;
      }

      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      removeChild(scene, node);

      return 0;
    },
    scene_get_node_count(sceneId: number) {
      const scene = getScriptResource(wasmCtx, RemoteScene, sceneId);

      if (!scene) {
        return -1;
      }

      return getScriptChildCount(wasmCtx, scene);
    },
    scene_get_nodes(sceneId: number, nodeArrPtr: number, maxCount: number) {
      const scene = getScriptResource(wasmCtx, RemoteScene, sceneId);

      if (!scene) {
        return -1;
      }

      return getScriptChildren(wasmCtx, scene, nodeArrPtr, maxCount);
    },
    scene_get_node(sceneId: number, index: number) {
      const scene = getScriptResource(wasmCtx, RemoteScene, sceneId);

      if (!scene) {
        return 0; // This function returns a u32 so errors returned as 0 / null eid
      }

      return scriptGetChildAt(wasmCtx, scene, index);
    },
    world_create_node(propsPtr: number) {
      try {
        moveCursorView(wasmCtx.cursorView, propsPtr);

        const cameraId = readUint32(wasmCtx.cursorView);

        let camera: RemoteCamera | undefined;

        if (cameraId) {
          camera = getScriptResource(wasmCtx, RemoteCamera, cameraId);

          if (!camera) {
            return 0;
          }
        }

        const skinId = readUint32(wasmCtx.cursorView);

        let skin: RemoteSkin | undefined;

        if (skinId) {
          skin = getScriptResource(wasmCtx, RemoteSkin, skinId);

          if (!skin) {
            return 0;
          }
        }

        const meshId = readUint32(wasmCtx.cursorView);

        let mesh: RemoteMesh | undefined;

        if (meshId) {
          mesh = getScriptResource(wasmCtx, RemoteMesh, meshId);

          if (!mesh) {
            return 0;
          }
        }

        const rotation = readFloat32Array(wasmCtx.cursorView, 4);
        const scale = readFloat32Array(wasmCtx.cursorView, 3);
        const translation = readFloat32Array(wasmCtx.cursorView, 3);

        // Skip weights
        skipUint32(wasmCtx.cursorView);
        skipUint32(wasmCtx.cursorView);

        const name = readStringFromCursorView(wasmCtx);

        return new RemoteNode(wasmCtx.resourceManager, {
          camera,
          skin,
          mesh,
          quaternion: rotation,
          scale,
          position: translation,
          name,
        }).eid;
      } catch (error) {
        console.error("WebSG: Error creating node:", error);
        return 0;
      }
    },
    world_find_node_by_name(namePtr: number, byteLength: number) {
      const node = getScriptResourceByNamePtr(ctx, wasmCtx, RemoteNode, namePtr, byteLength);
      return node ? node.eid : 0;
    },
    node_add_child(nodeId: number, childId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      const child = getScriptResource(wasmCtx, RemoteNode, childId);

      if (!child) {
        return -1;
      }

      addChild(node, child);

      return 0;
    },
    node_remove_child(nodeId: number, childId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      const child = getScriptResource(wasmCtx, RemoteNode, childId);

      if (!child) {
        return -1;
      }

      removeChild(node, child);

      return 0;
    },
    node_get_child_count(nodeId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      return getScriptChildCount(wasmCtx, node);
    },
    node_get_children(nodeId: number, childArrPtr: number, maxCount: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      return getScriptChildren(wasmCtx, node, childArrPtr, maxCount);
    },
    node_get_child(nodeId: number, index: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return 0; // This function returns a u32 so errors returned as 0 / null eid
      }

      return scriptGetChildAt(wasmCtx, node, index);
    },
    node_get_parent(nodeId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return 0; // This function returns a u32 so errors returned as 0 / null eid
      }

      const parent = node.parent;

      if (!parent) {
        return 0;
      }

      if (!wasmCtx.resourceManager.resourceIds.has(parent.eid)) {
        return 0;
      }

      return parent.eid;
    },
    node_get_parent_scene(nodeId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return 0; // This function returns a u32 so errors returned as 0 / null eid
      }

      const parentScene = node.parentScene;

      if (!parentScene) {
        return 0;
      }

      if (!wasmCtx.resourceManager.resourceIds.has(parentScene.eid)) {
        return 0;
      }

      return parentScene.eid;
    },
    node_get_translation_element(nodeId: number, index: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      return node.position[index];
    },
    node_set_translation_element(nodeId: number, index: number, value: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      node.position[index] = value;

      return 0;
    },
    node_get_translation(nodeId: number, translationPtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      writeFloat32Array(wasmCtx, translationPtr, node.position);

      return 0;
    },
    node_set_translation(nodeId: number, translationPtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      readFloat32ArrayInto(wasmCtx, translationPtr, node.position);

      return 0;
    },
    node_get_rotation_element(nodeId: number, index: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      return node.quaternion[index];
    },
    node_set_rotation_element(nodeId: number, index: number, value: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      node.quaternion[index] = value;

      return 0;
    },
    node_get_rotation(nodeId: number, rotationPtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      writeFloat32Array(wasmCtx, rotationPtr, node.quaternion);

      return 0;
    },
    node_set_rotation(nodeId: number, rotationPtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      readFloat32ArrayInto(wasmCtx, rotationPtr, node.quaternion);

      return 0;
    },
    node_get_scale_element(nodeId: number, index: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      return node.scale[index];
    },
    node_set_scale_element(nodeId: number, index: number, value: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      node.scale[index] = value;

      return 0;
    },
    node_get_scale(nodeId: number, scalePtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      writeFloat32Array(wasmCtx, scalePtr, node.scale);

      return 0;
    },
    node_set_scale(nodeId: number, scalePtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      readFloat32ArrayInto(wasmCtx, scalePtr, node.scale);

      return 0;
    },
    node_get_matrix_element(nodeId: number, index: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      return node.localMatrix[index];
    },
    node_set_matrix_element(nodeId: number, index: number, value: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      node.localMatrix[index] = value;

      return 0;
    },
    node_get_matrix(nodeId: number, matrixPtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      writeFloat32Array(wasmCtx, matrixPtr, node.localMatrix);

      return 0;
    },
    node_set_matrix(nodeId: number, matrixPtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      readFloat32ArrayInto(wasmCtx, matrixPtr, node.localMatrix);

      return 0;
    },
    node_get_world_matrix_element(nodeId: number, index: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      return node.worldMatrix[index];
    },
    node_get_world_matrix(nodeId: number, worldMatrixPtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      writeFloat32Array(wasmCtx, worldMatrixPtr, node.worldMatrix);

      return 0;
    },
    node_get_visible(nodeId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);
      return node && node.visible ? 1 : 0;
    },
    node_set_visible(nodeId: number, visible: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      node.visible = !!visible;

      return 0;
    },
    node_get_is_static(nodeId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);
      return node && node.isStatic ? 1 : 0;
    },
    node_set_is_static(nodeId: number, isStatic: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      node.isStatic = !!isStatic;

      return 0;
    },
    node_set_is_static_recursive(nodeId: number, isStatic: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      traverse(node, (child) => {
        child.isStatic = !!isStatic;
      });

      return 0;
    },
    node_get_mesh(nodeId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return 0; // This function returns a u32 so errors returned as 0
      }

      return getScriptResourceRef(wasmCtx, RemoteMesh, node.mesh);
    },
    node_set_mesh(nodeId: number, meshId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      const mesh = getScriptResource(wasmCtx, RemoteMesh, meshId);

      if (!mesh) {
        return -1;
      }

      node.mesh = mesh;

      return 0;
    },
    node_get_light(nodeId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return 0; // This function returns a u32 so errors returned as 0
      }

      return getScriptResourceRef(wasmCtx, RemoteLight, node.light);
    },
    node_set_light(nodeId: number, lightId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      const light = getScriptResource(wasmCtx, RemoteLight, lightId);

      if (!light) {
        return -1;
      }

      node.light = light;

      return 0;
    },
    node_get_collider(nodeId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return 0; // This function returns a u32 so errors returned as 0
      }

      return getScriptResourceRef(wasmCtx, RemoteCollider, node.collider);
    },
    node_set_collider(nodeId: number, colliderId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      const collider = getScriptResource(wasmCtx, RemoteCollider, colliderId);

      if (!collider) {
        return -1;
      }

      node.collider = collider;

      return 0;
    },
    node_start_orbit(nodeId: number, propsPtr: number) {
      moveCursorView(wasmCtx.cursorView, propsPtr);
      const pitch = readFloat32(wasmCtx.cursorView);
      const yaw = readFloat32(wasmCtx.cursorView);
      const zoom = readFloat32(wasmCtx.cursorView);

      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      startOrbit(ctx, node, { pitch, yaw, zoom });

      return 0;
    },
    stop_orbit() {
      stopOrbit(ctx);
      return 0;
    },
    world_create_mesh(propsPtr: number) {
      try {
        moveCursorView(wasmCtx.cursorView, propsPtr);
        const primitivesPtr = readUint32(wasmCtx.cursorView);
        const primitivesCount = readUint32(wasmCtx.cursorView);

        // Skip weights
        skipUint32(wasmCtx.cursorView);
        skipUint32(wasmCtx.cursorView);

        const name = readStringFromCursorView(wasmCtx);

        const primitiveProps: MeshPrimitiveProps[] = [];
        const MESH_PRIMITIVE_PROPS_BYTE_LENGTH = 20;

        for (let primitiveIndex = 0; primitiveIndex < primitivesCount; primitiveIndex++) {
          moveCursorView(wasmCtx.cursorView, primitivesPtr + primitiveIndex * MESH_PRIMITIVE_PROPS_BYTE_LENGTH);

          const attributesPtr = readUint32(wasmCtx.cursorView);
          const attributeCount = readUint32(wasmCtx.cursorView);
          const MESH_PRIMITIVE_ATTRIBUTE_BYTE_LENGTH = 8;

          const attributes: { [key: number]: RemoteAccessor } = {};

          for (let attributeIndex = 0; attributeIndex < attributeCount; attributeIndex++) {
            moveCursorView(wasmCtx.cursorView, attributesPtr + attributeIndex * MESH_PRIMITIVE_ATTRIBUTE_BYTE_LENGTH);
            const attributeKey = readUint32(wasmCtx.cursorView);

            if (MeshPrimitiveAttributeIndex[attributeKey] === undefined) {
              console.error(`WebSG: invalid mesh primitive key: ${attributeKey}`);
              return -1;
            }

            const attributeAccessorId = readUint32(wasmCtx.cursorView);

            const accessor = getScriptResource(wasmCtx, RemoteAccessor, attributeAccessorId);

            if (accessor === undefined) {
              return -1;
            }

            attributes[attributeKey] = accessor;
          }

          const indicesAccessorId = readUint32(wasmCtx.cursorView);

          let indices: RemoteAccessor | undefined;

          if (indicesAccessorId) {
            indices = getScriptResource(wasmCtx, RemoteAccessor, indicesAccessorId);

            if (!indices) {
              return -1;
            }
          }

          const materialId = readUint32(wasmCtx.cursorView);

          let material: RemoteMaterial | undefined;

          if (materialId) {
            material = getScriptResource(wasmCtx, RemoteMaterial, materialId);

            if (!material) {
              return -1;
            }
          }

          const mode = readUint32(wasmCtx.cursorView);

          if (MeshPrimitiveMode[mode] === undefined) {
            console.error(`WebSG: invalid mesh primitive mode: ${mode}`);
            return -1;
          }

          primitiveProps.push({
            mode,
            indices,
            material,
            attributes,
          });
        }

        const primitives: RemoteMeshPrimitive[] = [];

        // Create all the resources after parsing props to try to avoid leaking resources on error.

        for (let i = 0; i < primitiveProps.length; i++) {
          const props = primitiveProps[i];
          primitives.push(new RemoteMeshPrimitive(wasmCtx.resourceManager, props));
        }

        const mesh = new RemoteMesh(wasmCtx.resourceManager, { name, primitives });

        return mesh.eid;
      } catch (error) {
        console.error(`WebSG: error creating mesh:`, error);
        return 0;
      }
    },
    world_find_mesh_by_name(namePtr: number, byteLength: number) {
      const mesh = getScriptResourceByNamePtr(ctx, wasmCtx, RemoteMesh, namePtr, byteLength);
      return mesh ? mesh.eid : 0;
    },
    mesh_get_primitive_count(meshId: number) {
      const mesh = getScriptResource(wasmCtx, RemoteMesh, meshId);
      return mesh ? mesh.primitives.length : -1;
    },
    mesh_get_primitive_attribute(meshId: number, index: number, attribute: MeshPrimitiveAttributeIndex) {
      const mesh = getScriptResource(wasmCtx, RemoteMesh, meshId);
      return mesh?.primitives[index]?.attributes[attribute]?.eid || 0;
    },
    mesh_get_primitive_indices(meshId: number, index: number) {
      const mesh = getScriptResource(wasmCtx, RemoteMesh, meshId);
      return mesh?.primitives[index]?.indices?.eid || 0;
    },
    mesh_get_primitive_material(meshId: number, index: number) {
      const mesh = getScriptResource(wasmCtx, RemoteMesh, meshId);
      return mesh?.primitives[index]?.material?.eid || 0;
    },
    mesh_set_primitive_material(meshId: number, index: number, materialId: number) {
      const mesh = getScriptResource(wasmCtx, RemoteMesh, meshId);

      const primitive = mesh?.primitives[index];

      if (!primitive) {
        return -1;
      }

      const material = getScriptResource(wasmCtx, RemoteMaterial, materialId);

      if (!material) {
        return -1;
      }

      primitive.material = material;

      return 0;
    },
    mesh_set_primitive_hologram_material_enabled(meshId: number, index: number, enabled: number) {
      const mesh = getScriptResource(wasmCtx, RemoteMesh, meshId);

      const primitive = mesh?.primitives[index];

      if (!primitive) {
        return -1;
      }

      primitive.hologramMaterialEnabled = !!enabled;

      return 0;
    },
    mesh_get_primitive_mode(meshId: number, index: number) {
      const mesh = getScriptResource(wasmCtx, RemoteMesh, meshId);
      return mesh?.primitives[index]?.mode || 0;
    },
    mesh_set_primitive_draw_range(meshId: number, index: number, start: number, count: number) {
      const mesh = getScriptResource(wasmCtx, RemoteMesh, meshId);
      const meshPrimitive = mesh?.primitives[index];

      if (!meshPrimitive) {
        console.error(`WebSG: couldn't find mesh primitive: ${index} on mesh ${meshId}`);
        return -1;
      }

      meshPrimitive.drawStart = start;
      meshPrimitive.drawCount = count;

      return 0;
    },
    world_create_box_mesh(propsPtr: number) {
      moveCursorView(wasmCtx.cursorView, propsPtr);
      const size = readFloat32Array(wasmCtx.cursorView, 3);
      const segments = readUint32Array(wasmCtx.cursorView, 3);
      const materialId = readUint32(wasmCtx.cursorView);

      const geometry = new BoxGeometry(size[0], size[1], size[2], segments[0], segments[1], segments[2]);

      let material: RemoteMaterial | undefined = undefined;

      if (materialId) {
        material = getScriptResource(wasmCtx, RemoteMaterial, materialId);

        if (!material) {
          return -1;
        }
      }

      const mesh = createMesh(ctx, geometry, material, wasmCtx.resourceManager);

      return mesh.eid;
    },
    world_create_accessor_from(dataPtr: number, byteLength: number, propsPtr: number) {
      try {
        const data = readSharedArrayBuffer(wasmCtx, dataPtr, byteLength);
        moveCursorView(wasmCtx.cursorView, propsPtr);
        const type = readUint32(wasmCtx.cursorView);

        if (AccessorType[type] === undefined) {
          console.error(`WebSG: invalid accessor type: ${type}`);
          return 0;
        }

        const componentType = readUint32(wasmCtx.cursorView);

        if (AccessorComponentType[componentType] === undefined) {
          console.error(`WebSG: invalid accessor component type: ${componentType}`);
          return 0;
        }

        const count = readUint32(wasmCtx.cursorView);
        const normalized = !!readUint32(wasmCtx.cursorView);
        const dynamic = !!readUint32(wasmCtx.cursorView);
        // TODO: read min/max props

        const buffer = new RemoteBuffer(wasmCtx.resourceManager, { data });
        const bufferView = new RemoteBufferView(wasmCtx.resourceManager, { buffer, byteLength });
        const accessor = new RemoteAccessor(wasmCtx.resourceManager, {
          bufferView,
          type,
          componentType,
          count,
          normalized,
          dynamic,
        });

        return accessor.eid;
      } catch (error) {
        console.error(`WebSG: error creating accessor:`, error);
        return 0;
      }
    },
    world_find_accessor_by_name(namePtr: number, byteLength: number) {
      const accessor = getScriptResourceByNamePtr(ctx, wasmCtx, RemoteAccessor, namePtr, byteLength);
      return accessor ? accessor.eid : 0;
    },
    accessor_update_with(accessorId: number, dataPtr: number, byteLength: number) {
      const accessor = getScriptResource(wasmCtx, RemoteAccessor, accessorId);

      if (!accessor) {
        return -1;
      }

      if (!accessor.dynamic) {
        console.error("WebSG: cannot update non-dynamic accessor.");
        return -1;
      }

      if (accessor.sparse) {
        console.error("WebSG: cannot update sparse accessor.");
        return -1;
      }

      const bufferView = accessor.bufferView;

      if (!bufferView) {
        console.error("WebSG: cannot update accessor without bufferView.");
        return -1;
      }

      try {
        const elementCount = accessor.count;
        const elementSize = AccessorTypeToElementSize[accessor.type];
        const arrConstructor = AccessorComponentTypeToTypedArray[accessor.componentType];
        const componentByteLength = arrConstructor.BYTES_PER_ELEMENT;
        const elementByteLength = componentByteLength * elementSize;
        const buffer = bufferView.buffer.data;
        const byteOffset = accessor.byteOffset + bufferView.byteOffset;
        const byteStride = bufferView.byteStride;

        if (byteStride && byteStride !== elementByteLength) {
          console.error("WebSG: cannot update accessor with byteStride.");
          return -1;
        }

        // TODO: This creates garbage. See if we can keep around read/write views for dynamic accessors.
        const readView = readUint8Array(wasmCtx, dataPtr, byteLength);
        const writeView = new Uint8Array(buffer, byteOffset, elementCount * elementByteLength);
        writeView.set(readView);
        accessor.version++;

        return 0;
      } catch (error) {
        console.error(`WebSG: error updating accessor:`, error);
        return -1;
      }
    },
    world_create_material(propsPtr: number) {
      moveCursorView(wasmCtx.cursorView, propsPtr);

      const baseColorFactor = readFloat32Array(wasmCtx.cursorView, 4);
      const baseColorTexture = readTextureInfo(wasmCtx);
      const metallicFactor = readFloat32(wasmCtx.cursorView);
      const roughnessFactor = readFloat32(wasmCtx.cursorView);
      const metallicRoughnessTexture = readTextureInfo(wasmCtx);
      const normalTextureInfo = readNormalTextureInfo(wasmCtx);
      const [
        occlusionTexture,
        occlusionTextureStrength,
        occlusionTextureOffset,
        occlusionTextureRotation,
        occlusionTextureScale,
      ] = readOcclusionTextureInfo(wasmCtx);
      const emissiveTexture = readTextureInfo(wasmCtx);
      const emissiveFactor = readFloat32Array(wasmCtx.cursorView, 3);
      const alphaMode = readUint32(wasmCtx.cursorView);
      const alphaCutoff = readFloat32(wasmCtx.cursorView);
      const doubleSided = !!readUint32(wasmCtx.cursorView);
      const name = readStringFromCursorView(wasmCtx);
      const extensions = readExtensions(wasmCtx, (wasmCtx, name) => {
        if (name === "KHR_materials_unlit") {
          return {};
        }

        return {};
      });

      const type = "KHR_materials_unlit" in extensions ? MaterialType.Unlit : MaterialType.Standard;

      readExtensions(wasmCtx);
      readExtras(wasmCtx.cursorView);

      const material = new RemoteMaterial(wasmCtx.resourceManager, {
        type,
        baseColorFactor,
        baseColorTexture,
        metallicFactor,
        roughnessFactor,
        metallicRoughnessTexture,
        ...normalTextureInfo,
        occlusionTexture,
        occlusionTextureStrength,
        emissiveTexture,
        emissiveFactor,
        alphaMode,
        alphaCutoff,
        doubleSided,
        name,
      });

      return material.eid;
    },
    world_find_material_by_name(namePtr: number, byteLength: number) {
      const material = getScriptResourceByNamePtr(ctx, wasmCtx, RemoteMaterial, namePtr, byteLength);
      return material ? material.eid : 0;
    },
    material_get_base_color_factor(materialId: number, colorPtr: number) {
      const material = getScriptResource(wasmCtx, RemoteMaterial, materialId);

      if (!material) {
        return -1;
      }

      writeFloat32Array(wasmCtx, colorPtr, material.baseColorFactor);

      return 0;
    },
    material_set_base_color_factor(materialId: number, colorPtr: number) {
      const material = getScriptResource(wasmCtx, RemoteMaterial, materialId);

      if (!material) {
        return -1;
      }

      readFloat32ArrayInto(wasmCtx, colorPtr, material.baseColorFactor);

      return 0;
    },
    material_get_metallic_factor(materialId: number) {
      const material = getScriptResource(wasmCtx, RemoteMaterial, materialId);
      return material?.metallicFactor || 0;
    },
    material_set_metallic_factor(materialId: number, metallicFactor: number) {
      const material = getScriptResource(wasmCtx, RemoteMaterial, materialId);

      if (!material) {
        return -1;
      }

      material.metallicFactor = metallicFactor;

      return 0;
    },
    material_get_roughness_factor(materialId: number) {
      const material = getScriptResource(wasmCtx, RemoteMaterial, materialId);
      return material?.roughnessFactor || 0;
    },
    material_set_roughness_factor(materialId: number, roughnessFactor: number) {
      const material = getScriptResource(wasmCtx, RemoteMaterial, materialId);

      if (!material) {
        return -1;
      }

      material.roughnessFactor = roughnessFactor;

      return 0;
    },
    material_get_emissive_factor(materialId: number, colorPtr: number) {
      const material = getScriptResource(wasmCtx, RemoteMaterial, materialId);

      if (!material) {
        return -1;
      }

      writeFloat32Array(wasmCtx, colorPtr, material.emissiveFactor);

      return 0;
    },
    material_set_emissive_factor(materialId: number, colorPtr: number) {
      const material = getScriptResource(wasmCtx, RemoteMaterial, materialId);

      if (!material) {
        return -1;
      }

      readFloat32ArrayInto(wasmCtx, colorPtr, material.emissiveFactor);

      return 0;
    },
    material_get_base_color_texture(materialId: number) {
      const material = getScriptResource(wasmCtx, RemoteMaterial, materialId);

      if (!material) {
        return 0; // This function returns a u32 so errors returned as 0
      }

      return getScriptResourceRef(wasmCtx, RemoteTexture, material.baseColorTexture);
    },
    material_set_base_color_texture(materialId: number, textureId: number) {
      const material = getScriptResource(wasmCtx, RemoteMaterial, materialId);

      if (!material) {
        return -1;
      }

      const baseColorTexture = getScriptResource(wasmCtx, RemoteTexture, textureId);

      if (!baseColorTexture) {
        return -1;
      }

      material.baseColorTexture = baseColorTexture;

      return 0;
    },
    texture_find_by_name(namePtr: number, byteLength: number) {
      const texture = getScriptResourceByNamePtr(ctx, wasmCtx, RemoteTexture, namePtr, byteLength);
      return texture ? texture.eid : 0;
    },
    light_find_by_name(namePtr: number, byteLength: number) {
      const light = getScriptResourceByNamePtr(ctx, wasmCtx, RemoteLight, namePtr, byteLength);
      return light ? light.eid : 0;
    },
    create_light(type: number) {
      if (LightType[type] === undefined) {
        console.error("WebSG: Invalid light type.");
        return -1;
      }

      const light = new RemoteLight(wasmCtx.resourceManager, { type });

      return light.eid;
    },
    light_get_color(lightId: number, colorPtr: number) {
      const light = getScriptResource(wasmCtx, RemoteLight, lightId);

      if (!light) {
        return -1;
      }

      writeFloat32Array(wasmCtx, colorPtr, light.color);

      return 0;
    },
    light_set_color(lightId: number, colorPtr: number) {
      const light = getScriptResource(wasmCtx, RemoteLight, lightId);

      if (!light) {
        return -1;
      }

      readFloat32ArrayInto(wasmCtx, colorPtr, light.color);

      return 0;
    },
    light_get_intensity(lightId: number) {
      const light = getScriptResource(wasmCtx, RemoteLight, lightId);
      return light?.intensity || 0;
    },
    light_set_intensity(lightId: number, intensity: number) {
      const light = getScriptResource(wasmCtx, RemoteLight, lightId);

      if (!light) {
        return -1;
      }

      light.intensity = intensity;

      return 0;
    },
    add_interactable(nodeId: number, type: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      if (node.interactable) {
        console.error("WebSG: node is already interactable.");
        return -1;
      }

      if (type !== InteractableType.Interactable) {
        console.error("WebSG: Invalid interactable type.");
        return -1;
      }

      node.interactable = new RemoteInteractable(wasmCtx.resourceManager, { type });

      return 0;
    },
    remove_interactable(nodeId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      if (!node.interactable) {
        console.error("WebSG: node is not interactable.");
        return -1;
      }

      node.interactable = undefined;

      return 0;
    },
    has_interactable(nodeId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);
      return node?.interactable ? 1 : 0;
    },
    get_interactable(nodeId: number, interactablePtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      const interactable = node.interactable;

      if (!interactable) {
        return -1;
      }

      moveCursorView(wasmCtx.cursorView, interactablePtr);
      writeUint32(wasmCtx.cursorView, interactable.type); // Note we might be exposing other interactable types here
      writeUint32(wasmCtx.cursorView, interactable.pressed ? 1 : 0);
      writeUint32(wasmCtx.cursorView, interactable.held ? 1 : 0);
      writeUint32(wasmCtx.cursorView, interactable.released ? 1 : 0);

      return 0;
    },
    get_interactable_pressed(nodeId: number, interactablePtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      const interactable = node.interactable;

      if (!interactable) {
        return -1;
      }

      return interactable.pressed ? 1 : 0;
    },
    get_interactable_held(nodeId: number, interactablePtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      const interactable = node.interactable;

      if (!interactable) {
        return -1;
      }

      return interactable.held ? 1 : 0;
    },
    get_interactable_released(nodeId: number, interactablePtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      const interactable = node.interactable;

      if (!interactable) {
        return -1;
      }

      return interactable.released ? 1 : 0;
    },
    collider_find_by_name(namePtr: number, byteLength: number) {
      const collider = getScriptResourceByNamePtr(ctx, wasmCtx, RemoteCollider, namePtr, byteLength);
      return collider ? collider.eid : 0;
    },
    create_collider(colliderPropsPtr: number) {
      moveCursorView(wasmCtx.cursorView, colliderPropsPtr);

      const type = readUint32(wasmCtx.cursorView);

      if (ColliderType[type] === undefined) {
        console.error(`WebSG: invalid collider type: ${type}`);
        return -1;
      }

      // TODO: Add more checks for valid props per type
      const isTrigger = !!readUint32(wasmCtx.cursorView);
      const size = readFloat32Array(wasmCtx.cursorView, 3);
      const radius = readFloat32(wasmCtx.cursorView);
      const height = readFloat32(wasmCtx.cursorView);
      const meshId = readUint32(wasmCtx.cursorView);
      const mesh = meshId ? getScriptResource(wasmCtx, RemoteMesh, meshId) : undefined;

      const collider = new RemoteCollider(wasmCtx.resourceManager, {
        type,
        isTrigger,
        size,
        radius,
        height,
        mesh,
      });

      return collider.eid;
    },
    add_physics_body(nodeId: number, propsPtr: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      if (hasComponent(ctx.world, RigidBody, node.eid)) {
        console.error("WebSG: node already has a rigid body.");
        return -1;
      }

      moveCursorView(wasmCtx.cursorView, propsPtr);

      const type = readUint32(wasmCtx.cursorView);

      if (PhysicsBodyType[type] === undefined) {
        console.error(`WebSG: invalid physics body type: ${type}`);
        return -1;
      }

      let rigidBodyDesc: RAPIER.RigidBodyDesc;
      let meshResource: RemoteMesh | undefined;
      let primitiveResource: RemoteMeshPrimitive | undefined;

      if (type === PhysicsBodyType.Rigid) {
        rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic();
      } else if (type === PhysicsBodyType.Kinematic) {
        rigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
      } else {
        rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
      }

      rigidBodyDesc.linvel.x = readFloat32(wasmCtx.cursorView);
      rigidBodyDesc.linvel.y = readFloat32(wasmCtx.cursorView);
      rigidBodyDesc.linvel.z = readFloat32(wasmCtx.cursorView);

      rigidBodyDesc.angvel.x = readFloat32(wasmCtx.cursorView);
      rigidBodyDesc.angvel.y = readFloat32(wasmCtx.cursorView);
      rigidBodyDesc.angvel.z = readFloat32(wasmCtx.cursorView);

      // const inertiaTensor = readFloat32Array(wasmCtx.cursorView, 9);

      const { physicsWorld } = getModule(ctx, PhysicsModule);

      const rigidBody = physicsWorld.createRigidBody(rigidBodyDesc);

      const nodeColliderDesc = createNodeColliderDesc(node);

      if (nodeColliderDesc) {
        physicsWorld.createCollider(nodeColliderDesc, rigidBody);
      }

      let curChild = node.firstChild;

      while (curChild) {
        if (!hasComponent(ctx.world, RigidBody, curChild.eid)) {
          const childColliderDesc = createNodeColliderDesc(curChild);

          if (childColliderDesc) {
            physicsWorld.createCollider(childColliderDesc, rigidBody);
          }
        }

        curChild = curChild.nextSibling;
      }

      addRigidBody(ctx, node, rigidBody, meshResource, primitiveResource);

      return 0;
    },
    remove_physics_body(nodeId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);

      if (!node) {
        return -1;
      }

      removeRigidBody(ctx.world, node.eid);

      return 0;
    },
    has_physics_body(nodeId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);
      return node && hasComponent(ctx.world, RigidBody, node.eid) ? 1 : 0;
    },
    // UI Canvas
    create_ui_canvas(propsPtr: number) {
      moveCursorView(wasmCtx.cursorView, propsPtr);
      const size = readFloat32Array(wasmCtx.cursorView, 2);
      const width = readFloat32(wasmCtx.cursorView);
      const height = readFloat32(wasmCtx.cursorView);

      try {
        const uiCanvas = new RemoteUICanvas(wasmCtx.resourceManager, {
          size,
          width,
          height,
        });
        return uiCanvas.eid;
      } catch (e) {
        console.error("WebSG: error creating ui canvas", e);
        return -1;
      }
    },
    node_set_ui_canvas(nodeId: number, canvasId: number) {
      const node = getScriptResource(wasmCtx, RemoteNode, nodeId);
      const canvas = getScriptResource(wasmCtx, RemoteUICanvas, canvasId);

      if (!canvas || !node) {
        return -1;
      }

      node.uiCanvas = canvas;

      const { width, height } = canvas;

      // setup collider
      const rigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
      const rigidBody = physics.physicsWorld.createRigidBody(rigidBodyDesc);
      const colliderDesc = RAPIER.ColliderDesc.cuboid(width / 2, height / 2, 0.01)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(dynamicObjectCollisionGroups);
      physics.physicsWorld.createCollider(colliderDesc, rigidBody);

      addRigidBody(ctx, node, rigidBody);

      addInteractableComponent(ctx, physics, node, InteractableType.UI);

      return 0;
    },
    ui_canvas_get_root(canvasId: number) {
      const canvas = getScriptResource(wasmCtx, RemoteUICanvas, canvasId);

      if (!canvas) {
        return 0; // This function returns a u32 so errors returned as 0 / null eid
      }

      const root = canvas.root;

      if (!root) {
        return 0;
      }

      if (!wasmCtx.resourceManager.resourceIds.has(root.eid)) {
        return 0;
      }

      return root.eid;
    },
    ui_canvas_set_root(canvasId: number, rootId: number) {
      const canvas = getScriptResource(wasmCtx, RemoteUICanvas, canvasId);

      if (!canvas) {
        return -1;
      }

      const flex = getScriptResource(wasmCtx, RemoteUIElement, rootId);

      if (!flex) {
        return -1;
      }

      canvas.root = flex;

      return 0;
    },
    ui_canvas_get_width(canvasId: number) {
      const canvas = getScriptResource(wasmCtx, RemoteUICanvas, canvasId);

      if (!canvas) {
        return -1;
      }

      return canvas.width;
    },
    ui_canvas_set_width(canvasId: number, width: number) {
      const canvas = getScriptResource(wasmCtx, RemoteUICanvas, canvasId);

      if (!canvas) {
        return -1;
      }

      canvas.width = width;

      return 0;
    },
    ui_canvas_get_height(canvasId: number) {
      const canvas = getScriptResource(wasmCtx, RemoteUICanvas, canvasId);

      if (!canvas) {
        return -1;
      }

      return canvas.height;
    },
    ui_canvas_set_height(canvasId: number, height: number) {
      const canvas = getScriptResource(wasmCtx, RemoteUICanvas, canvasId);

      if (!canvas) {
        return -1;
      }

      canvas.height = height;

      return 0;
    },
    ui_canvas_redraw(canvasId: number) {
      const canvas = getScriptResource(wasmCtx, RemoteUICanvas, canvasId);

      if (!canvas) {
        return -1;
      }

      canvas.redraw++;

      return 0;
    },

    // UI Flex

    create_ui_flex(propsPtr: number) {
      moveCursorView(wasmCtx.cursorView, propsPtr);
      const width = readFloat32(wasmCtx.cursorView);
      const height = readFloat32(wasmCtx.cursorView);
      const flexDirection = readUint32(wasmCtx.cursorView);
      const backgroundColor = readFloat32Array(wasmCtx.cursorView, 4);
      const borderColor = readFloat32Array(wasmCtx.cursorView, 4);
      const padding = readFloat32Array(wasmCtx.cursorView, 4);
      const margin = readFloat32Array(wasmCtx.cursorView, 4);

      try {
        const uiElement = new RemoteUIElement(wasmCtx.resourceManager, {
          width,
          height,
          flexDirection,
          backgroundColor,
          borderColor,
          padding,
          margin,
        });
        return uiElement.eid;
      } catch (e) {
        console.error("WebSG: error creating ui flex", e);
        return -1;
      }
    },
    ui_flex_set_flex_direction(flexId: number, flexDirection: number) {
      const flex = getScriptResource(wasmCtx, RemoteUIElement, flexId);

      if (!flex) {
        return -1;
      }

      flex.flexDirection = flexDirection;

      return 0;
    },
    ui_flex_set_width(flexId: number, width: number) {
      const flex = getScriptResource(wasmCtx, RemoteUIElement, flexId);

      if (!flex) {
        return -1;
      }

      flex.width = width;

      return 0;
    },
    ui_flex_set_height(flexId: number, height: number) {
      const flex = getScriptResource(wasmCtx, RemoteUIElement, flexId);

      if (!flex) {
        return -1;
      }

      flex.height = height;

      return 0;
    },
    ui_flex_set_background_color(flexId: number, colorPtr: number) {
      const flex = getScriptResource(wasmCtx, RemoteUIElement, flexId);

      if (!flex) {
        return -1;
      }

      readFloat32ArrayInto(wasmCtx, colorPtr, flex.backgroundColor);

      return 0;
    },
    ui_flex_set_border_color(flexId: number, colorPtr: number) {
      const flex = getScriptResource(wasmCtx, RemoteUIElement, flexId);

      if (!flex) {
        return -1;
      }

      readFloat32ArrayInto(wasmCtx, colorPtr, flex.borderColor);

      return 0;
    },
    ui_flex_set_padding(flexId: number, paddingPtr: number) {
      const flex = getScriptResource(wasmCtx, RemoteUIElement, flexId);

      if (!flex) {
        return -1;
      }

      readFloat32ArrayInto(wasmCtx, paddingPtr, flex.padding);

      return 0;
    },
    ui_flex_set_margin(flexId: number, marginPtr: number) {
      const flex = getScriptResource(wasmCtx, RemoteUIElement, flexId);

      if (!flex) {
        return -1;
      }

      readFloat32ArrayInto(wasmCtx, marginPtr, flex.margin);

      return 0;
    },
    ui_flex_add_child(flexId: number, childId: number) {
      const flex = getScriptResource(wasmCtx, RemoteUIElement, flexId);

      if (!flex) {
        return -1;
      }

      const child = getScriptResource(wasmCtx, RemoteUIElement, childId);

      if (!child) {
        return -1;
      }

      addUIElementChild(flex, child);

      return 0;
    },
    ui_flex_add_text(flexId: number, textId: number) {
      const flex = getScriptResource(wasmCtx, RemoteUIElement, flexId);

      if (!flex) {
        return -1;
      }

      const text = getScriptResource(wasmCtx, RemoteUIText, textId);

      if (!text) {
        return -1;
      }

      flex.text = text;

      return 0;
    },

    ui_flex_add_button(flexId: number, buttonId: number) {
      const flex = getScriptResource(wasmCtx, RemoteUIElement, flexId);

      if (!flex) {
        return -1;
      }

      const button = getScriptResource(wasmCtx, RemoteUIButton, buttonId);

      if (!button) {
        return -1;
      }

      flex.button = button;

      return 0;
    },

    // UI Button

    create_ui_button(labelPtr: number, length: number) {
      const label = readString(wasmCtx, labelPtr, length);
      try {
        const uiBtn = new RemoteUIButton(wasmCtx.resourceManager, { label });
        addInteractableComponent(ctx, physics, uiBtn, InteractableType.UI);
        return uiBtn.eid;
      } catch (e) {
        console.error("WebSG: error creating ui button", e);
        return -1;
      }
    },
    ui_button_set_label(btnId: number, labelPtr: number, length: number) {
      const btn = getScriptResource(wasmCtx, RemoteUIButton, btnId);

      if (!btn) {
        return -1;
      }

      const label = readString(wasmCtx, labelPtr, length);

      if (!label) {
        return -1;
      }

      btn.label = label;

      return 0;
    },
    ui_button_get_pressed(btnId: number) {
      const btn = getScriptResource(wasmCtx, RemoteUIButton, btnId);

      if (!btn) {
        return -1;
      }

      const interactable = btn.interactable;

      if (!interactable) {
        return -1;
      }

      return interactable.pressed ? 1 : 0;
    },
    ui_button_get_held(btnId: number) {
      const btn = getScriptResource(wasmCtx, RemoteUIButton, btnId);

      if (!btn) {
        return -1;
      }

      const interactable = btn.interactable;

      if (!interactable) {
        return -1;
      }

      return interactable.held ? 1 : 0;
    },
    ui_button_get_released(btnId: number) {
      const btn = getScriptResource(wasmCtx, RemoteUIButton, btnId);

      if (!btn) {
        return -1;
      }

      const interactable = btn.interactable;

      if (!interactable) {
        return -1;
      }

      return interactable.released ? 1 : 0;
    },

    // UI Text

    create_ui_text(propsPtr: number) {
      moveCursorView(wasmCtx.cursorView, propsPtr);

      const fontSize = readFloat32(wasmCtx.cursorView);
      const color = readFloat32Array(wasmCtx.cursorView, 4);
      const valuePtr = readUint32(wasmCtx.cursorView);
      const valueLen = readUint32(wasmCtx.cursorView);
      const fontFamilyPtr = readUint32(wasmCtx.cursorView);
      const fontFamilyLen = readUint32(wasmCtx.cursorView);
      const fontWeightPtr = readUint32(wasmCtx.cursorView);
      const fontWeightLen = readUint32(wasmCtx.cursorView);
      const fontStylePtr = readUint32(wasmCtx.cursorView);
      const fontStyleLen = readUint32(wasmCtx.cursorView);

      const value = valuePtr ? readString(wasmCtx, valuePtr, valueLen) : undefined;
      const fontFamily = fontFamilyPtr ? readString(wasmCtx, fontFamilyPtr, fontFamilyLen) : undefined;
      const fontWeight = fontWeightPtr ? readString(wasmCtx, fontWeightPtr, fontWeightLen) : undefined;
      const fontStyle = fontStylePtr ? readString(wasmCtx, fontStylePtr, fontStyleLen) : undefined;

      try {
        const uiText = new RemoteUIText(wasmCtx.resourceManager, {
          value,
          color,
          fontSize,
          fontFamily,
          fontWeight,
          fontStyle,
        });
        return uiText.eid;
      } catch (e) {
        console.error("WebSG: error creating ui flex", e);
        return -1;
      }
    },
    ui_text_set_value(textId: number, valuePtr: number, byteLength: number) {
      const value = readString(wasmCtx, valuePtr, byteLength);
      const flex = getScriptResource(wasmCtx, RemoteUIText, textId);

      if (!flex) {
        return -1;
      }

      flex.value = value;

      return 0;
    },
    ui_text_set_font_size(textId: number, fontSize: number) {
      const flex = getScriptResource(wasmCtx, RemoteUIText, textId);

      if (!flex) {
        return -1;
      }

      flex.fontSize = fontSize;

      return 0;
    },
    ui_text_set_font_family(textId: number, valuePtr: number, byteLength: number) {
      const fontFamily = readString(wasmCtx, valuePtr, byteLength);
      const flex = getScriptResource(wasmCtx, RemoteUIText, textId);

      if (!flex) {
        return -1;
      }

      flex.fontFamily = fontFamily;

      return 0;
    },
    ui_text_set_font_style(textId: number, valuePtr: number, byteLength: number) {
      const fontStyle = readString(wasmCtx, valuePtr, byteLength);
      const flex = getScriptResource(wasmCtx, RemoteUIText, textId);

      if (!flex) {
        return -1;
      }

      flex.fontStyle = fontStyle;

      return 0;
    },
    ui_text_set_color(textId: number, colorPtr: number) {
      const flex = getScriptResource(wasmCtx, RemoteUIText, textId);

      if (!flex) {
        return -1;
      }

      readFloat32ArrayInto(wasmCtx, colorPtr, flex.color);
    },
  };
}
