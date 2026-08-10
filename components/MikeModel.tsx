"use client";

import { useGLTF } from "@react-three/drei";
import { useEffect } from "react";
import * as THREE from "three";

export interface MikeBounds {
  feetY: number;
  headY: number;
}

interface MikeModelProps {
  onMeasured?: (bounds: MikeBounds) => void;
}

const MODEL_POSITION: [number, number, number] = [
  -3.1,
  0,
  0.4,
];

const MODEL_ROTATION: [number, number, number] = [
  0,
  0.25,
  0,
];

const MODEL_SCALE = 2.4;

export default function MikeModel({
  onMeasured,
}: MikeModelProps) {
  const { scene } = useGLTF("/models/MIKE.glb");

  useEffect(() => {
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
  }, [scene]);

  useEffect(() => {
    scene.position.set(...MODEL_POSITION);
    scene.rotation.set(...MODEL_ROTATION);
    scene.scale.setScalar(MODEL_SCALE);

    scene.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(scene);

    onMeasured?.({
      feetY: box.min.y,
      headY: box.max.y,
    });
  }, [scene, onMeasured]);

  return (
    <primitive
      object={scene}
      position={MODEL_POSITION}
      rotation={MODEL_ROTATION}
      scale={MODEL_SCALE}
    />
  );
}

useGLTF.preload("/models/MIKE.glb");