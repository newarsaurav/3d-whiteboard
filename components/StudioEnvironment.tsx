export default function StudioEnvironment() {
  return (
    <>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.02, 0]}
        receiveShadow
      >
        <planeGeometry args={[24, 18]} />

        <meshStandardMaterial
          color="#272b38"
          roughness={0.9}
        />
      </mesh>

      <mesh position={[0, 4, -4]} receiveShadow>
        <boxGeometry args={[18, 8, 0.2]} />

        <meshStandardMaterial
          color="#161925"
          roughness={0.85}
        />
      </mesh>
    </>
  );
}